import uuid
from django.db import models


class Interview(models.Model):
    STATUS = [("active", "Active"), ("completed", "Completed"), ("terminated", "Terminated")]

    uid = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    resume = models.FileField(upload_to="resumes/")
    resume_text = models.TextField(blank=True)
    jd_text = models.TextField(blank=True)
    status = models.CharField(max_length=12, choices=STATUS, default="active")
    covered_topics = models.JSONField(default=list)
    max_questions = models.PositiveSmallIntegerField(default=7)
    tab_warnings = models.PositiveSmallIntegerField(default=0)
    final_score = models.FloatField(null=True, blank=True)
    summary = models.JSONField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"Interview {self.uid}"


class Question(models.Model):
    MODES = [("opener", "Opener"), ("follow_up", "Follow-up"),
             ("new_topic", "New topic"), ("jd_gap", "JD gap")]

    interview = models.ForeignKey(Interview, on_delete=models.CASCADE, related_name="questions")
    order = models.PositiveSmallIntegerField()
    text = models.TextField()
    mode = models.CharField(max_length=10, choices=MODES)
    topic = models.CharField(max_length=120, blank=True)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.SET_NULL)

    class Meta:
        ordering = ["order"]


class Answer(models.Model):
    question = models.OneToOneField(Question, on_delete=models.CASCADE, related_name="answer")
    text = models.TextField()
    input_mode = models.CharField(max_length=5, default="typed") 
    relevance = models.FloatField(null=True)  
    depth = models.FloatField(null=True)       
    clarity = models.FloatField(null=True)
    feedback = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    @property
    def score(self):
        vals = [v for v in (self.relevance, self.depth, self.clarity) if v is not None]
        return round(sum(vals) / len(vals), 1) if vals else None


class ProctorEvent(models.Model):
    KINDS = [("tab_switch", "Tab switch"), ("no_face", "No face"), ("multi_face", "Multiple faces")]

    interview = models.ForeignKey(Interview, on_delete=models.CASCADE, related_name="events")
    kind = models.CharField(max_length=12, choices=KINDS)
    created_at = models.DateTimeField(auto_now_add=True)