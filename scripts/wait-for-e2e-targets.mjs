const targets = [process.env.E2E_BASE_URL, process.env.E2E_API_HEALTH_URL].filter(Boolean);
const deadline = Date.now() + 120_000;

for (const target of targets) {
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(target);
      if (response.ok) {
        lastError = undefined;
        break;
      }
      lastError = Error(`${target} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (lastError) throw lastError;
}
