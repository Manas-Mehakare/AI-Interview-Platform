document.getElementById("startForm").addEventListener("submit", function () {
  const btn = document.getElementById("btn");
  btn.disabled = true;
  btn.textContent = "Preparing your interview...";
});