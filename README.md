# AI Interview Platform

An AI-powered mock interview platform. The candidate uploads a resume (required) and, optionally, a job description. An AI interviewer then asks questions **live, one at a time**, either following up on the previous answer or moving to a new topic from the resume. Candidates can **type or speak** their answers, and every question is shown on screen and read aloud. The session is **proctored** with webcam face detection and tab-switch tracking, and ends with a scored report.

> Academic project, Department of Computer Science & Engineering, MIT School of Computing, Loni Kalbhor.

## Features

- **Resume-based interviews:** resume (PDF/DOCX) is mandatory; job description is optional.
- **Adaptive questions:** nothing is pre-generated. Each next question is a follow-up, a new resume topic, or (if a JD is given) a JD-gap question.
- **Two-way voice:** speak your answer (transcribed with Whisper) or type it; the AI's questions are shown and spoken aloud.
- **Face detection:** missing or multiple faces for more than 3 seconds are logged as proctoring events.
- **Tab-switch rule:** the 1st switch shows a warning, the 2nd ends the interview. Enforced on the server.
- **Scoring and report:** each answer is scored on relevance, depth and clarity, with a final score out of 100, strengths, weaknesses, per-question feedback and a proctoring log.

## Tech stack

| Layer | Technology |
|---|---|
| Language / backend | Python, Django |
| Database | SQLite |
| Frontend | Django templates, HTML, CSS, vanilla JavaScript (ES modules) |
| LLM (questions + scoring) | Groq API, `openai/gpt-oss-120b` |
| Speech to text | Groq API, `whisper-large-v3-turbo` |
| Face detection | MediaPipe Face Detector (runs in the browser) |
| Tab-switch detection | Page Visibility API |
| Text to speech | Browser `speechSynthesis` |
| Resume parsing | `pdfplumber`, `python-docx` |

## Project structure

```
manage.py
requirements.txt
.env                      # your secrets (not committed)
config/                   # Django project settings and root URLs
interview/
├── models.py             # Interview, Question, Answer, ProctorEvent
├── engine.py             # resume parsing, adaptive questions, scoring, transcription
├── views.py              # pages + JSON endpoints (answer, event, transcribe)
├── forms.py
├── urls.py
├── templates/interview/  # start.html, room.html, report.html
└── static/interview/
    ├── css/              # start.css, room.css, report.css
    └── js/               # start.js, room.js, face.js, voice.js, proctor.js
```

## Setup

You need Python 3.10+ and a free [Groq API key](https://console.groq.com).

```bash
# 1. Create and activate a virtual environment
python -m venv .venv
.venv\Scripts\activate            # Windows
# source .venv/bin/activate       # macOS / Linux

# 2. Install dependencies
pip install -r requirements.txt

# 3. Add your API key: create a file named .env next to manage.py
#    containing this single line:
#    GROQ_API_KEY=your_key_here

# 4. Create the database
python manage.py makemigrations interview
python manage.py migrate

# 5. Run
python manage.py runserver
```

Open **http://localhost:8000** in **Chrome or Edge**.

## How to use

1. Upload your resume (and optionally paste a job description) and click **Start interview**.
2. In the pre-check popup, click **Enable camera and mic**. Wait until face detection shows **ready**, then click **Start interview**.
3. The AI asks the first question (shown and spoken). Type your answer, or press **🎤 Speak**, talk, then press **⏹ Stop**. The transcript appears in the box and you can edit it.
4. Press **Submit answer**. The next question depends on what you said.
5. After the last question (or if the interview is terminated) you land on the report page.

## How it works

- **Question modes:** `choose_mode()` in `engine.py` picks the next mode. A short answer forces a follow-up, two follow-ups in a row force a new topic, and with a JD there is a small chance of a JD-gap question. One LLM call per turn scores the answer and writes the next question.
- **Scoring:** answer score = average of relevance, depth and clarity (0 to 10). Final score = average × 10, minus an integrity penalty of 5 per tab switch and 3 per face event (capped at 30).
- **Proctoring:** the browser reports events to the server. After a face problem lasts 3 seconds it is logged, then repeated every 10 seconds while it continues. The server counts tab switches and ends the interview on the second one.

## Configuration

| What | Where | Default |
|---|---|---|
| Number of questions | `max_questions` in `interview/models.py` (then run `makemigrations` and `migrate`) | 7 |
| Question and scoring model | `GROQ_MODEL` in `config/settings.py` | `openai/gpt-oss-120b` |
| Speech-to-text model | `GROQ_STT_MODEL` in `config/settings.py` | `whisper-large-v3-turbo` |
| API key | `GROQ_API_KEY` in `.env` | none |

## Testing on other devices (HTTPS tunnel)

Camera and microphone only work on `localhost` or HTTPS, so other devices need a tunnel:

1. Add to `config/settings.py`:
   ```python
   CSRF_TRUSTED_ORIGINS = ["https://*.trycloudflare.com"]
   SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
   ```
2. In a second terminal run `cloudflared tunnel --url http://localhost:8000` and share the `https://...trycloudflare.com` link it prints.

Only share the link with your team, and stop the tunnel when you are done.

## Troubleshooting

| Problem | Fix |
|---|---|
| `no such table: interview_interview` | Run `python manage.py makemigrations interview` then `python manage.py migrate`. |
| "AI service error" or a 404 `model_not_found` | Set `GROQ_MODEL` to a model your Groq account lists. |
| "AI service error" with an empty key | `GROQ_API_KEY` is not loaded. Check `.env` is next to `manage.py`, then restart the server. |
| "Didn't catch that" / mic seems silent | Check the input device and volume in your system sound settings. The app shows the name of the mic it is using when it hears almost no sound. Bluetooth earbuds may need reconnecting. |
| Mic or camera blocked | Allow access from the lock icon in the address bar, and use `localhost` or HTTPS. |
| Resume rejected | Use a text-based PDF or DOCX (not a scanned image), up to 5 MB. |

## Limitations

- Needs an internet connection (Groq API and the MediaPipe face model load from the web).
- Voice answers appear after you press Stop, not live while you speak.
- Tab-switch detection uses the Page Visibility API, so it does not catch every case of working in another window that stays visible next to the browser.
- Designed for Chrome and Edge.

## Project Author

**Manas Mehakare**
