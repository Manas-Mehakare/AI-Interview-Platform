from django import forms


class StartForm(forms.Form):
    resume = forms.FileField(label="Resume (PDF or DOCX) *")
    jd_text = forms.CharField(
        required=False,
        label="Job description (optional)",
        widget=forms.Textarea(attrs={"rows": 6, "placeholder": "Paste the JD here to tailor the interview"}),
    )

    def clean_resume(self):
        f = self.cleaned_data["resume"]
        if not f.name.lower().endswith((".pdf", ".docx")):
            raise forms.ValidationError("Upload a PDF or DOCX file.")
        if f.size > 5 * 1024 * 1024:
            raise forms.ValidationError("File too large (max 5 MB).")
        return f