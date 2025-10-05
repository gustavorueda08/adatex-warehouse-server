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
    return `${isVirtual ? "VIRTUAL-" : ""}${product.barcode}-${quantity * 100}-${lot}-${itemNumber ? itemNumber : Date.now()}${containerCode ? `-${containerCode}` : ""}`;
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
  if (isVirtual) {
    return `VITRUAL${productCode}${itemNumber}${lotNumber}${dateCode}`;
  }
  return `${productCode}${itemNumber}${lotNumber}${containerCode ? convertCode(containerCode) : ""}`;
}

module.exports = {
  generateItemBarcode,
  setItemBarcode,
};
