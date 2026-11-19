from django.urls import path

from . import views

app_name = "interview"

urlpatterns = [
    path("", views.start, name="start"),
    path("i/<uuid:uid>/", views.room, name="room"),
    path("i/<uuid:uid>/answer/", views.answer, name="answer"),
    path("i/<uuid:uid>/event/", views.event, name="event"),
    path("i/<uuid:uid>/report/", views.report, name="report"),
    path("i/<uuid:uid>/transcribe/", views.transcribe, name="transcribe"),
]