import json

from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.views.decorators.http import require_POST

from .engine import extract_resume_text, finalize, process_answer, start_interview, transcribe_audio
from .forms import StartForm
from .models import Interview, ProctorEvent

EVENT_KINDS = {"tab_switch", "no_face", "multi_face"}


def _body(request):
    try:
        return json.loads(request.body or "{}")
    except json.JSONDecodeError:
        return {}


def _report_url(interview):
    return reverse("interview:report", args=[interview.uid])


def _current_question(interview):
    return interview.questions.filter(answer__isnull=True).order_by("order").first()


# ---------- pages ----------
def start(request):
    form = StartForm(request.POST or None, request.FILES or None)
    if request.method == "POST" and form.is_valid():
        interview = Interview.objects.create(
            resume=form.cleaned_data["resume"],
            jd_text=form.cleaned_data["jd_text"].strip(),
        )
        try:
            interview.resume_text = extract_resume_text(interview.resume.path)
        except Exception:
            interview.resume_text = ""

        if len(interview.resume_text) < 50:
            interview.delete()
            form.add_error("resume", "Couldn't read text from this file. Use a text-based PDF or DOCX, not a scan.")
        else:
            interview.save(update_fields=["resume_text"])
            try:
                start_interview(interview)
            except Exception as e:
                import traceback; traceback.print_exc()
                interview.delete()
                form.add_error(None, f"AI service error: {e}")
            else:
                return redirect("interview:room", uid=interview.uid)
    return render(request, "interview/start.html", {"form": form})


def room(request, uid):
    interview = get_object_or_404(Interview, uid=uid)
    if interview.status != "active":
        return redirect("interview:report", uid=uid)

    question = _current_question(interview)
    if not question:                    
        finalize(interview)
        return redirect("interview:report", uid=uid)

    return render(request, "interview/room.html", {
        "interview": interview,
        "question": question,
    })


def report(request, uid):
    interview = get_object_or_404(Interview, uid=uid)
    if interview.status == "active":
        return redirect("interview:room", uid=uid)
    questions = interview.questions.filter(answer__isnull=False).select_related("answer")
    events = {
        "tab_switch": interview.events.filter(kind="tab_switch").count(),
        "no_face": interview.events.filter(kind="no_face").count(),
        "multi_face": interview.events.filter(kind="multi_face").count(),
    }
    return render(request, "interview/report.html", {
        "interview": interview, "questions": questions, "events": events,
    })


# ---------- JSON endpoints ----------
@require_POST
def answer(request, uid):
    interview = get_object_or_404(Interview, uid=uid)
    if interview.status != "active":
        return JsonResponse({"done": True, "report_url": _report_url(interview)})

    data = _body(request)
    text = (data.get("text") or "").strip()
    if not text:
        return JsonResponse({"error": "Empty answer"}, status=400)

    question = _current_question(interview)
    if not question:
        return JsonResponse({"error": "No open question"}, status=400)

    input_mode = "voice" if data.get("input_mode") == "voice" else "typed"
    try:
        nxt = process_answer(interview, question, text, input_mode)
    except Exception:
        return JsonResponse({"error": "AI error, please resend your answer"}, status=502)

    if nxt is None:                      # last question answered
        finalize(interview)
        return JsonResponse({"done": True, "report_url": _report_url(interview)})

    return JsonResponse({
        "done": False,
        "question": nxt.text,
        "number": nxt.order,
        "total": interview.max_questions,
    })


@require_POST
def event(request, uid):
    interview = get_object_or_404(Interview, uid=uid)
    if interview.status != "active":
        return JsonResponse({"terminated": True, "report_url": _report_url(interview)})

    kind = _body(request).get("kind")
    if kind not in EVENT_KINDS:
        return JsonResponse({"error": "bad kind"}, status=400)

    ProctorEvent.objects.create(interview=interview, kind=kind)

    if kind == "tab_switch":
        interview.tab_warnings += 1
        interview.save(update_fields=["tab_warnings"])
        if interview.tab_warnings >= 2:                  # 2nd switch -> terminate
            finalize(interview, "terminated")
            return JsonResponse({"terminated": True, "report_url": _report_url(interview)})
        return JsonResponse({"warning": interview.tab_warnings})

    return JsonResponse({"ok": True})

@require_POST
def transcribe(request, uid):
    interview = get_object_or_404(Interview, uid=uid)
    if interview.status != "active":
        return JsonResponse({"error": "Interview is not active"}, status=400)
    audio = request.FILES.get("audio")
    if not audio or audio.size < 1000:
        return JsonResponse({"text": ""})
    if audio.size > 10 * 1024 * 1024:
        return JsonResponse({"error": "Recording too long"}, status=400)
    try:
        text = transcribe_audio(audio)
        # print("STT:", repr(text), "| audio bytes:", audio.size)
    except Exception as e:
        print("STT error:", e)
        return JsonResponse({"error": "Transcription failed. Please type your answer."}, status=502)
    return JsonResponse({"text": text})