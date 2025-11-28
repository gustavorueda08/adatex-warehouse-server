"use strict";

// Formatea nombres en estilo título conservando conectores en minúsculas.
// Ejemplo: "PIEL DE DURAZNO - 160 / AZUL" => "Piel de Durazno - 160 / Azul"
const CONNECTORS = new Set([
  "de",
  "del",
  "la",
  "las",
  "el",
  "los",
  "y",
  "e",
  "o",
  "u",
  "al",
  "a",
  "con",
  "en",
  "por",
  "para",
  "sin",
]);

function formatName(value) {
  if (value === undefined || value === null) {
    return "";
  }

  const normalized = String(value).toLowerCase().trim();
  if (!normalized) {
    return "";
  }

  let wordIndex = 0;

  return normalized
    .split(/([\s/\-]+)/)
    .map((token) => {
      if (!token || /[\s/\-]+/.test(token)) {
        return token;
      }

      const isConnector = CONNECTORS.has(token);
      const isFirstWord = wordIndex === 0;
      wordIndex += 1;

      if (isConnector && !isFirstWord) {
        return token;
      }

      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = formatName;
