const moment = require("moment-timezone");

const convertCode = require("./convertContainerCode");

function generateItemBarcode(
  product,
  quantity,
  lot,
  itemNumber = null,
  containerCode = null,
  isVirtual = false
) {
  try {
    if (typeof product !== "object" && !product.barcode)
      throw new Error(
        "Se requiere el producto con código para generar el codigo del Item"
      );
    if (!quantity) throw new Error("Se requiere la cantidad");
    if (!lot) throw new Error("Se requiere el lote");

    // Convertir el containerCode si existe
    const convertedCode = containerCode ? convertCode(containerCode) : "";

    // Formatear lot e itemNumber con 4 dígitos (padding con ceros)
    const formattedLot = String(lot).padStart(4, "0");
    const formattedItemNumber = itemNumber
      ? String(itemNumber).padStart(4, "0")
      : Date.now();

    return `${isVirtual ? "VIRTUAL-" : ""}${product.barcode}${formattedLot}${formattedItemNumber}${convertedCode ? `${convertedCode}` : ""}`;
  } catch (error) {
    throw error;
  }
}

function setItemBarcode({
  productCode = "",
  itemNumber = "",
  lotNumber = "",
  containerCode = null,
  isVirtual = false,
}) {
  const now = moment();
  const dateCode = now.format("DDMMYYYYHHmmss");

  // Formatear itemNumber y lotNumber con 4 dígitos (padding con ceros)
  const formattedItemNumber = String(itemNumber).padStart(4, "0");
  const formattedLotNumber = String(lotNumber).padStart(4, "0");

  if (isVirtual) {
    return `VITRUAL${productCode}${formattedItemNumber}${formattedLotNumber}${dateCode}`;
  }
  return `${productCode}${formattedItemNumber}${formattedLotNumber}${containerCode ? convertCode(containerCode) : ""}`;
}

function generateAlternativeItemBarcode(code, quantity, containerCode) {
  try {
    if (!code) throw new Error("Se requiere el código del producto");
    if (quantity === null || quantity === undefined)
      throw new Error("Se requiere la cantidad");

    // Convertir el containerCode si existe, de lo contrario usar string vacío
    const convertedCode = containerCode ? convertCode(containerCode) : "";

    return `${code}-${quantity}${convertedCode ? `-${convertedCode}` : ""}`;
  } catch (error) {
    throw error;
  }
}

module.exports = {
  generateItemBarcode,
  setItemBarcode,
  generateAlternativeItemBarcode,
};
