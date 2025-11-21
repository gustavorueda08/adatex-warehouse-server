"use strict";

const path = require("path");
const fs = require("fs/promises");
const { createCanvas, Image } = require("canvas");
const { jsPDF } = require("jspdf");
const { autoTable } = require("jspdf-autotable");
const moment = require("moment-timezone");

/**
 * jsPDF y jspdf-autotable asumen la existencia de objetos DOM.
 * Cuando corremos en Node, creamos los stubs mínimos para que funcionen.
 */
if (typeof globalThis.document === "undefined") {
  globalThis.document = {
    createElement: () => createCanvas(1, 1),
  };
}

if (typeof globalThis.window === "undefined") {
  globalThis.window = { document: globalThis.document };
}

if (typeof globalThis.HTMLCanvasElement === "undefined") {
  globalThis.HTMLCanvasElement = createCanvas().constructor;
}

if (typeof globalThis.HTMLImageElement === "undefined") {
  globalThis.HTMLImageElement = Image;
}

/**
 * Genera el PDF de lista de empaque para una orden.
 * Retorna { buffer, fileName }
 * @param {Object} order
 * @returns {Promise<{buffer: Buffer, fileName: string}>}
 */
async function generatePackingListPDF(order, options = {}) {
  if (!order || !order.id) {
    throw new Error("Orden inválida para generar PDF");
  }

  const data = prepareDocumentData(order);
  const packingList = transformToPackingListStructure(order);
  const keys = Object.keys(packingList);

  if (keys.length === 0) {
    throw new Error(
      `La orden ${order.code || order.id} no tiene información para la lista de empaque`
    );
  }

  const namesRow = keys.map((key) => packingList[key].name);
  const quantitiesColumns = keys.map((key) => packingList[key].quantities);
  const quantitiesRows = transposeArray(quantitiesColumns);

  const totalByColumn = keys.map((key) =>
    packingList[key].quantities.reduce((acc, q) => acc + Number(q || 0), 0)
  );

  const totalItems = keys.map((key) => packingList[key].quantities.length);
  const itemsCount = quantitiesColumns.reduce(
    (acc, column) => acc + column.length,
    0
  );

  const totalQuantity = totalByColumn.reduce((acc, total) => acc + total, 0);

  const maxColumnsPerTable = 12;
  const needsMultipleTables = namesRow.length > maxColumnsPerTable;
  const isLandscape = namesRow.length > 3;
  const orientation = isLandscape ? "landscape" : "portrait";

  const doc = new jsPDF({
    orientation,
    unit: "mm",
    format: "letter",
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 10;
  const usableWidth = pageWidth - margin * 2;

  await addLogoToPDF(doc, pageWidth, margin, options.logoPath);

  let currentY = margin + 15;

  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(getDocumentTitle(data.type).toUpperCase(), margin, currentY);
  currentY += 10;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text("NIT: 901.738.541-1", pageWidth - margin - 40, currentY);
  currentY += 8;

  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");

  const documentInfo = [
    `FECHA: ${moment(data.createdDate, "DD/MM/YYYY").format("DD-MM-YY")}`,
    `${data.entityLabel.toUpperCase()}: ${data.entityName}`,
    `DIRECCIÓN: ${data.entityAddress}`,
    `${data.type === "sale" ? "FACTURA" : "CÓDIGO"}: ${data.invoiceLabel || data.code}`,
  ];

  documentInfo.forEach((info) => {
    doc.text(info, margin, currentY);
    currentY += 6;
  });

  currentY += 5;

  const createTable = (headers, rows, totals, rollCounts, startY) => {
    const tableData = rows.map((row) => [
      "",
      ...row.map((cell) => (cell != null ? format.roundNumber(cell) : "")),
    ]);

    tableData.push([
      getTotalUnitString(packingList, true),
      ...totals.map((total) => format.roundNumber(total)),
    ]);

    tableData.push([
      "TOTAL EMPAQUES",
      ...rollCounts.map((count) => `${count}`),
    ]);

    const tableHeaders = ["", ...headers];

    const tableConfig = {
      head: [tableHeaders],
      body: tableData,
      startY,
      theme: "grid",
      styles: {
        fontSize: Math.max(6, Math.min(9, 100 / headers.length)),
        cellPadding: 1.5,
        halign: "center",
        valign: "middle",
      },
      headStyles: {
        fillColor: [240, 240, 240],
        textColor: [0, 0, 0],
        fontStyle: "bold",
        fontSize: Math.max(7, Math.min(10, 105 / headers.length)),
      },
      columnStyles: {
        0: { cellWidth: 28, halign: "left", fontStyle: "bold" },
      },
      margin: { left: margin, right: margin },
      tableWidth: usableWidth,
      didParseCell: (cellData) => {
        const isLastRow = cellData.row.index === tableData.length - 1;
        const isSecondLastRow = cellData.row.index === tableData.length - 2;
        if (isLastRow || isSecondLastRow) {
          cellData.cell.styles.fontStyle = "bold";
          cellData.cell.styles.fillColor = [230, 230, 230];
        }
      },
    };

    const dataColumnCount = headers.length;
    const remainingWidth = usableWidth - 28;
    const dataColumnWidth = remainingWidth / dataColumnCount;

    for (let i = 1; i <= dataColumnCount; i++) {
      tableConfig.columnStyles[i] = { cellWidth: dataColumnWidth };
    }

    autoTable(doc, tableConfig);
    return doc.lastAutoTable.finalY;
  };

  if (needsMultipleTables) {
    const chunks = chunkArray(namesRow, maxColumnsPerTable);
    const totalChunks = chunkArray(totalByColumn, maxColumnsPerTable);
    const rollCountChunks = chunkArray(totalItems, maxColumnsPerTable);

    let tableStartY = currentY;

    for (let i = 0; i < chunks.length; i++) {
      if (chunks.length > 1) {
        doc.setFontSize(10);
        doc.setFont("helvetica", "bold");
        doc.text(`TABLA ${i + 1} de ${chunks.length}`, margin, tableStartY);
        tableStartY += 8;
      }

      const chunkData = quantitiesRows.map((row) =>
        row.slice(i * maxColumnsPerTable, (i + 1) * maxColumnsPerTable)
      );

      const finalY = createTable(
        chunks[i],
        chunkData,
        totalChunks[i],
        rollCountChunks[i],
        tableStartY
      );

      if (i < chunks.length - 1) {
        if (finalY + 50 > pageHeight) {
          doc.addPage();
          tableStartY = margin;
        } else {
          tableStartY = finalY + 15;
        }
      } else {
        currentY = finalY + 10;
      }
    }
  } else {
    currentY = createTable(
      namesRow,
      quantitiesRows,
      totalByColumn,
      totalItems,
      currentY
    );
  }

  if (currentY < pageHeight - 80) {
    currentY += 10;
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text("RESUMEN GENERAL", margin, currentY);
    currentY += 8;

    const summaryData = [
      [
        getTotalUnitString(packingList, true),
        format.roundNumber(totalQuantity),
      ],
      ["TOTAL EMPAQUES", `${itemsCount}`],
    ];

    autoTable(doc, {
      body: summaryData,
      startY: currentY,
      theme: "grid",
      styles: {
        fontSize: 10,
        cellPadding: 3,
      },
      columnStyles: {
        0: { cellWidth: 55, fontStyle: "bold", halign: "left" },
        1: { cellWidth: 30, halign: "center", fontStyle: "bold" },
      },
      margin: { left: margin },
    });
  }

  doc.addPage();
  await generateDetailedResumePDF(doc, packingList, data, options.logoPath);

  const fileName = generateFileName(order, ".pdf");
  const pdfBuffer = Buffer.from(doc.output("arraybuffer"));

  return { buffer: pdfBuffer, fileName };
}

async function addLogoToPDF(doc, pageWidth, margin, logoPath) {
  try {
    const resolvedPath =
      logoPath || path.join(process.cwd(), "public", "logo-horizontal.png");
    const logoExists = await fileExists(resolvedPath);
    if (!logoExists) {
      return;
    }
    const imageBuffer = await fs.readFile(resolvedPath);
    const base64Image = imageBuffer.toString("base64");
    const imageExtension = path.extname(resolvedPath).replace(".", "").toLowerCase();
    const imageType = imageExtension.toUpperCase();
    const logoWidth = 70;
    const logoHeight = 10;

    doc.addImage(
      `data:image/${imageExtension};base64,${base64Image}`,
      imageType,
      pageWidth - logoWidth - margin,
      margin,
      logoWidth,
      logoHeight
    );
  } catch (error) {
    console.warn("No se pudo agregar el logo al PDF:", error.message);
  }
}

async function generateDetailedResumePDF(doc, packingList, data, logoPath) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 10;
  let currentY = margin + 15;

  await addLogoToPDF(doc, pageWidth, margin, logoPath);

  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text("RESUMEN DETALLADO", margin, currentY);
  currentY += 10;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text("NIT: 901.738.541-1", pageWidth - margin - 40, currentY);
  currentY += 8;

  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");

  const documentInfo = [
    `FECHA: ${moment(data.createdDate, "DD/MM/YYYY").format("DD-MM-YY")}`,
    `${data.entityLabel.toUpperCase()}: ${data.entityName}`,
    `${data.type === "sale" ? "FACTURA" : "CÓDIGO"}: ${data.invoiceLabel || data.code}`,
  ];

  documentInfo.forEach((info) => {
    doc.text(info, margin, currentY);
    currentY += 6;
  });

  currentY += 10;

  const resumeItems = getResumeItemsFromPackingList(packingList);
  const tableData = resumeItems.map((item) => [
    item.name,
    format.roundNumber(item.totalQuantity),
    `${item.count}`,
    item.unit,
  ]);

  const totalQuantity = resumeItems.reduce(
    (acc, item) => acc + Number(item.totalQuantity || 0),
    0
  );
  const totalCount = resumeItems.reduce(
    (acc, item) => acc + Number(item.count || 0),
    0
  );

  tableData.push([
    "TOTALES",
    format.roundNumber(totalQuantity),
    `${totalCount}`,
    "",
  ]);

  autoTable(doc, {
    head: [["PRODUCTO", "CANTIDAD", "EMPAQUES", "UNIDAD"]],
    body: tableData,
    startY: currentY,
    theme: "grid",
    styles: {
      fontSize: 9,
      cellPadding: 3,
      halign: "center",
      valign: "middle",
    },
    headStyles: {
      fillColor: [240, 240, 240],
      textColor: [0, 0, 0],
      fontStyle: "bold",
      fontSize: 10,
    },
    columnStyles: {
      0: { cellWidth: 80, halign: "left" },
      1: { cellWidth: 30 },
      2: { cellWidth: 30 },
      3: { cellWidth: 25 },
    },
    margin: { left: margin, right: margin },
    didParseCell: (cellData) => {
      if (cellData.row.index === tableData.length - 1) {
        cellData.cell.styles.fontStyle = "bold";
        cellData.cell.styles.fillColor = [230, 230, 230];
      }
    },
  });
}

function prepareDocumentData(order) {
  const customer = order.customer || order.customerForInvoice || {};
  const address =
    customer.address || order.destinationWarehouse?.address || "SIN DIRECCIÓN";
  const invoiceLabel = buildInvoiceLabel(order);

  return {
    id: order.id,
    type: order.type || "sale",
    code: order.code || `ORDER-${order.id}`,
    createdDate: moment(order.createdDate).isValid()
      ? moment(order.createdDate).format("DD/MM/YYYY")
      : moment().format("DD/MM/YYYY"),
    entityLabel: order.type === "sale" ? "Cliente" : "Destino",
    entityName: customer.name || customer.legalName || "N/A",
    entityAddress: address,
    invoiceLabel,
  };
}

function transformToPackingListStructure(order) {
  const structure = {};

  (order.orderProducts || []).forEach((orderProduct) => {
    const base = orderProduct.product || {};
    const key = base.id || orderProduct.id || base.code || base.name;
    const name =
      orderProduct.name || base.name || `Producto ${orderProduct.id}`;
    const unit = orderProduct.unit || base.unit || "UN";

    const items = orderProduct.items || [];
    const quantities =
      items.length > 0
        ? items.map((item) =>
            Number(item.currentQuantity ?? item.originalQuantity ?? 0)
          )
        : [
            Number(
              orderProduct.deliveredQuantity ||
                orderProduct.confirmedQuantity ||
                0
            ),
          ];

    if (!structure[key]) {
      structure[key] = {
        name,
        unit,
        quantities: [],
      };
    }

    structure[key].quantities.push(...quantities);
  });

  return structure;
}

function transposeArray(columns) {
  const maxLength = Math.max(...columns.map((col) => col.length));
  const rows = [];

  for (let i = 0; i < maxLength; i++) {
    const row = columns.map((column) => column[i] ?? null);
    rows.push(row);
  }

  return rows;
}

function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

function getTotalUnitString(packingList, uppercase = false) {
  const units = new Set(
    Object.values(packingList)
      .map((entry) => entry.unit)
      .filter(Boolean)
  );
  const unit = units.size === 1 ? units.values().next().value : "UNIDADES";
  const label = `Total (${unit})`;
  return uppercase ? label.toUpperCase() : label;
}

function getResumeItemsFromPackingList(packingList) {
  return Object.values(packingList).map((entry) => ({
    name: entry.name,
    unit: entry.unit,
    totalQuantity: entry.quantities.reduce(
      (acc, quantity) => acc + Number(quantity || 0),
      0
    ),
    count: entry.quantities.length,
  }));
}

function generateFileName(order, extension = ".pdf") {
  const safeCode = (order.code || `order-${order.id}`).replace(/\s+/g, "-");
  const timestamp = moment().format("YYYYMMDD-HHmmss");
  return `packing-list-${safeCode}-${timestamp}${extension}`;
}

function getDocumentTitle(orderType) {
  const titles = {
    sale: "Lista de Empaque",
    transfer: "Lista de Transferencia",
    purchase: "Packing List",
  };
  return titles[orderType] || "Lista de Empaque";
}

const format = {
  roundNumber(value) {
    if (value == null || Number.isNaN(Number(value))) {
      return "";
    }
    return Number(value).toFixed(2).replace(/\.00$/, "");
  },
};

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getInvoiceNumberTypeA(order) {
  return (
    order.invoiceNumberTypeA ||
    order.invoiceNumber ||
    order.siigoIdTypeA ||
    order.siigoId ||
    null
  );
}

function getInvoiceNumberTypeB(order) {
  return order.invoiceNumberTypeB || order.siigoIdTypeB || null;
}

function buildInvoiceLabel(order) {
  const invoiceA = getInvoiceNumberTypeA(order);
  const invoiceB = getInvoiceNumberTypeB(order);
  const parts = [];

  if (invoiceA) {
    parts.push(`ADTX-${invoiceA}`);
  }

  if (invoiceB) {
    parts.push(`AD-${invoiceB}`);
  }

  const code = order.code || `ORDER-${order.id}`;
  if (code) {
    parts.push(code);
  }

  return parts.join(" | ");
}

module.exports = {
  generatePackingListPDF,
  prepareDocumentData,
  transformToPackingListStructure,
};
