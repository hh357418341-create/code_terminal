export function createClientId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const randomValues = new Uint32Array(4);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(randomValues);
  } else {
    for (let index = 0; index < randomValues.length; index += 1) {
      randomValues[index] = Math.floor(Math.random() * 0xffffffff);
    }
  }

  const randomPart = Array.from(randomValues, (value) => value.toString(16).padStart(8, "0")).join("");
  return `${Date.now().toString(36)}-${randomPart}`;
}
