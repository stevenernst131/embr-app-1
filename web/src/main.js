import "./style.css";

const result = document.querySelector("#result");
const button = document.querySelector("#load-status");

button.addEventListener("click", async () => {
  result.textContent = "Loading...";

  try {
    const response = await fetch("/api/status");
    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    result.textContent = JSON.stringify(await response.json(), null, 2);
  } catch (error) {
    result.textContent = error.message;
  }
});

