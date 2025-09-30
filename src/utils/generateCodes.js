function generateItemBarcode(
  product,
  quantity,
  lot,
  itemNumber = null,
  containerCode = null,
  isVirtual = false
) {
  if (typeof product !== "object" && !product.barcode)
    throw new Error(
      "Se requiere el producto con código para generar el codigo del Item"
    );
  if (!quantity) throw new Error("Se requiere la cantidad");
  if (!lot) throw new Error("Se requiere el lote");
  return `${isVirtual ? "VIRTUAL-" : ""}${product.barcode}-${quantity * 100}-${lot}-${itemNumber ? itemNumber : Date.now()}${containerCode && `-${containerCode}`}`;
}

module.exports = {
  generateItemBarcode,
};
