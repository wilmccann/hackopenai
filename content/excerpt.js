// HackyTab Agent: page excerpt (spec F10). Injected on demand with
// chrome.scripting.executeScript({ files: ["content/excerpt.js"] }).
// The completion value of this script is the excerpt string.
//
// The page controls everything this script reads (meta content, innerText),
// so the result is treated as untrusted data: control, bidi, and zero-width
// characters are stripped and the length is capped here, and again in
// agent/plan.js before anything reaches the model.
//
// Sources, in order: the page's own description meta tag, else the start of
// <main>. There is deliberately no document.body fallback: on webmail, banking,
// admin consoles, and vaults the first 300 characters of the body are the
// user's private data, and a page without a description or a <main> landmark
// is described well enough by its title and URL.
(() => {
  try {
    const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
    let text = (meta && meta.content ? meta.content : "").trim();
    if (!text) {
      const main = document.querySelector("main");
      text = (main && main.innerText ? main.innerText : "").replace(/\s+/g, " ").trim();
    }
    text = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]/g, "");
    return text.slice(0, 300);
  } catch {
    return "";
  }
})();
