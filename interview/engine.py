import json
import random

import docx
import pdfplumber
from django.conf import settings
from groq import Groq

from .models import Answer, Question
from .scoring import RUBRIC, grade_answer

client = Groq(api_key=settings.GROQ_API_KEY)
MODEL = getattr(settings, "GROQ_MODEL", "llama-3.3-70b-versatile")

SYSTEM = """You are a professional technical interviewer conducting a live interview.
Ask ONE question at a time. Be conversational and concise (max 2 sentences).
Never reveal scores. Never ask something already covered. Respond with JSON only."""

MODE_HINTS = {
    "opener": "Start the interview with a warm one-line greeting, then ask the candidate to walk through their most relevant project or experience from the resume.",
    "follow_up": "Dig deeper into something specific from the candidate's last answer (a vague claim, a tech choice, a tradeoff).",
    "new_topic": "Move to a DIFFERENT project, skill or experience from the resume that is not in the covered topics.",
    "jd_gap": "Probe a requirement from the job description that the resume does not clearly demonstrate.",
}


# ---------- resume parsing ----------
def extract_resume_text(path: str) -> str:
    low = path.lower()
    if low.endswith(".pdf"):
        with pdfplumber.open(path) as pdf:
            text = "\n".join(p.extract_text() or "" for p in pdf.pages)
    elif low.endswith(".docx"):
        text = "\n".join(p.text for p in docx.Document(path).paragraphs)
    else:
        raise ValueError("Only PDF or DOCX resumes are supported")
    return text.strip()


# ---------- LLM helper ----------
def _llm_json(user_prompt: str, temperature: float = 0.7) -> dict:
    r = client.chat.completions.create(
        model=MODEL,
        temperature=temperature,
        response_format={"type": "json_object"},
        messages=[{"role": "system", "content": SYSTEM},
                  {"role": "user", "content": user_prompt}],
    )
    return json.loads(r.choices[0].message.content)


def _context(interview) -> str:
    return (
        f"RESUME:\n{interview.resume_text[:6000]}\n\n"
        f"JOB DESCRIPTION:\n{interview.jd_text[:3000] or 'None provided'}\n\n"
        f"TOPICS ALREADY COVERED: {interview.covered_topics}\n"
    )


def _history(interview, n=4) -> str:
    qs = interview.questions.filter(answer__isnull=False).order_by("-order")[:n][::-1]
    return "\n".join(f"Q: {q.text}\nA: {q.answer.text}" for q in qs) or "None yet"


# ---------- mode selection ----------
def choose_mode(interview, last_answer: str) -> str:
    recent = list(interview.questions.order_by("-order").values_list("mode", flat=True)[:2])
    if recent[:2] == ["follow_up", "follow_up"]:
        return "new_topic"                      
    if len(last_answer.split()) < 15:
        return "follow_up"                       
    if interview.jd_text and random.random() < 0.15:
        return "jd_gap"
    return random.choices(["follow_up", "new_topic"], weights=[60, 40])[0]


# ---------- turns ----------
def _save_question(interview, data, mode, parent=None) -> Question:
    topic = (data.get("topic") or "").strip()
    if topic and topic not in interview.covered_topics:
        interview.covered_topics.append(topic)
        interview.save(update_fields=["covered_topics"])
    return Question.objects.create(
        interview=interview,
        order=interview.questions.count() + 1,
        text=data["question"].strip(),
        mode=mode,
        topic=topic,
        parent=parent,
    )


def start_interview(interview) -> Question:
    prompt = (
        _context(interview)
        + f"\nMODE: {MODE_HINTS['opener']}\n"
        + 'Return JSON: {"question": str, "topic": str}'
    )
    return _save_question(interview, _llm_json(prompt), "opener")


def process_answer(interview, question: Question, text: str, input_mode="typed"):
    """Score the answer and (unless finished) generate the next question in ONE LLM call."""
    is_last = interview.questions.count() >= interview.max_questions
    mode = None if is_last else choose_mode(interview, text)

    prompt = (
        _context(interview)
        + f"\nRECENT CONVERSATION:\n{_history(interview)}\n\n"
        + f"CURRENT QUESTION: {question.text}\nCANDIDATE ANSWER: {text}\n\n"
        + RUBRIC
    )
    if is_last:
        prompt += '\n\nThis was the final question. Return JSON: {"relevance": n, "depth": n, "clarity": n, "feedback": str}'
    else:
        prompt += (
            f"\n\nNEXT QUESTION MODE: {mode} - {MODE_HINTS[mode]}\n"
            'Return JSON: {"relevance": n, "depth": n, "clarity": n, "feedback": str, '
            '"question": str, "topic": str}'
        )

    data = _llm_json(prompt, temperature=0.3)
    if not is_last and not str(data.get("question") or "").strip():
        raise ValueError("LLM returned no question")

    g = grade_answer(text, data)
    Answer.objects.create(
        question=question, text=text, input_mode=input_mode,
        relevance=g["relevance"], depth=g["depth"],
        clarity=g["clarity"], feedback=g["feedback"],
    )
    if is_last:
        return None
    parent = question if mode == "follow_up" else None
    return _save_question(interview, data, mode, parent)


# ---------- final scoring ----------
def finalize(interview, status="completed"):
    answers = Answer.objects.filter(question__interview=interview)
    scores = [a.score for a in answers if a.score is not None]
    base = (sum(scores) / len(scores)) * 10 if scores else 0

    tabs = interview.events.filter(kind="tab_switch").count()
    face = interview.events.exclude(kind="tab_switch").count()
    penalty = min(30, tabs * 5 + face * 3)

    summary = {"strengths": [], "weaknesses": []}
    if answers:
        convo = "\n".join(f"Q: {a.question.text}\nA: {a.text}\nScore: {a.score}" for a in answers)
        try:
            summary = _llm_json(
                convo + '\n\nReturn JSON: {"strengths": [str, str], "weaknesses": [str, str], "verdict": str}'
            )
        except Exception:
            pass

    interview.final_score = max(0, round(base - penalty, 1))
    interview.summary = {**summary, "base_score": round(base, 1), "integrity_penalty": penalty}
    interview.status = status
    interview.save()
    return interview

STT_MODEL = getattr(settings, "GROQ_STT_MODEL", "whisper-large-v3-turbo")


def transcribe_audio(file) -> str:
    r = client.audio.transcriptions.create(
        file=(file.name or "answer.webm", file.read()),
        model=STT_MODEL,
        language="en",
        temperature=0.0,
    )
    text = (r.text or "").strip()
    if text.lower().strip(" .!?") in {"thank you", "thanks for watching", "you"}:
        return ""
    return text