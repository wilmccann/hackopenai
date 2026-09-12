// HackyTab Agent: page excerpt (spec F10). Injected on demand with
// chrome.scripting.executeScript({ files: ["content/excerpt.js"] }).
// The completion value of this script is the excerpt string.
(() => {
  try {
    const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
    let text = (meta && meta.content ? meta.content : "").trim();
    if (!text) {
      const root = document.querySelector("main") || document.body;
      text = (root && root.innerText ? root.innerText : "").replace(/\s+/g, " ").trim();
    }
    return text.slice(0, 300);
  } catch {
    return "";
  }
})();
