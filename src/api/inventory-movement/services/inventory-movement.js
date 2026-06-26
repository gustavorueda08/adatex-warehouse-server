"use strict";

const path = require("path");
const fs = require("fs");
const moment = require("moment-timezone");

const { INVENTORY_MOVEMENT_SERVICE } = require("../../../utils/services");
const INVENTORY_MOVEMENT_TYPES = require("../../../utils/inventoryMovementTypes");
const {
  validateRequiredFields,
} = require("../../../utils/validateRequiredFields");

/**
 * inventory-movement service
 */

const { createCoreService } = require("@strapi/strapi").factories;

const TZ = "America/Bogota";

/**
 * Movement types that represent a real, physical change in stock. Logical
 * allocations (reserve / unreserve) are excluded from the fiscal Kardex.
 */
const PHYSICAL_TYPES = [
  INVENTORY_MOVEMENT_TYPES.IN,
  INVENTORY_MOVEMENT_TYPES.RETURN,
  INVENTORY_MOVEMENT_TYPES.OUT,
  INVENTORY_MOVEMENT_TYPES.ADJUSTMENT,
  INVENTORY_MOVEMENT_TYPES.TRANSFORM,
  INVENTORY_MOVEMENT_TYPES.TRANSFER,
];

const TYPE_LABELS = {
  in: "Entrada",
  return: "Devolución",
  out: "Salida",
  transfer: "Traslado",
  adjustment: "Ajuste",
  transform: "Transformación",
};

/**
 * Effect of a movement on the consolidated (all-warehouses) product balance,
 * expressed in signed quantity.
 *
 * - in / return  → positive (stored as absolute value)
 * - out          → negative (stored as absolute value)
 * - adjustment   → signed quantity as stored
 * - transform    → signed quantity as stored (source negative, destination positive)
 * - transfer     → 0 (internal move between warehouses; net stock unchanged)
 */
function effectOf(movement) {
  const q = Number(movement.quantity) || 0;
  switch (movement.type) {
    case INVENTORY_MOVEMENT_TYPES.IN:
    case INVENTORY_MOVEMENT_TYPES.RETURN:
      return Math.abs(q);
    case INVENTORY_MOVEMENT_TYPES.OUT:
      return -Math.abs(q);
    case INVENTORY_MOVEMENT_TYPES.ADJUSTMENT:
    case INVENTORY_MOVEMENT_TYPES.TRANSFORM:
      return q;
    case INVENTORY_MOVEMENT_TYPES.TRANSFER:
    default:
      return 0;
  }
}

/** Resolves the tercero (NIT + name) for a movement via its order. */
function pickTercero(order) {
  if (!order) return { nit: "", name: "" };
  if (order.supplier) {
    return {
      nit: order.supplier.identification || "",
      name: order.supplier.name || "",
    };
  }
  if (order.customer) {
    const c = order.customer;
    const name =
      [c.name, c.lastName].filter(Boolean).join(" ") || c.companyName || "";
    return { nit: c.identification || "", name };
  }
  return { nit: "", name: "" };
}

/** Best-effort DIAN invoice reference attached to the order. */
function invoiceLabel(order) {
  if (!order) return "";
  return (
    order.invoiceNumber ||
    order.invoiceNumberTypeA ||
    order.invoiceNumberTypeB ||
    order.purchaseInvoiceNumber ||
    ""
  );
}

/** Warehouse description per movement type. */
function warehouseLabel(movement) {
  const src = movement.sourceWarehouse?.name;
  const dst = movement.destinationWarehouse?.name;
  switch (movement.type) {
    case INVENTORY_MOVEMENT_TYPES.IN:
    case INVENTORY_MOVEMENT_TYPES.RETURN:
      return dst || src || "";
    case INVENTORY_MOVEMENT_TYPES.OUT:
      return src || dst || "";
    case INVENTORY_MOVEMENT_TYPES.TRANSFER:
      return [src, dst].filter(Boolean).join(" → ");
    default:
      return dst || src || "";
  }
}

module.exports = createCoreService(
  "api::inventory-movement.inventory-movement",
  ({ strapi }) => ({
    async create(data) {
      try {
        const requireFields = [
          "type",
          "quantity",
          "item",
          "order",
          "trx",
          "balanceBefore",
          "balanceAfter",
        ];
        const missingFields = validateRequiredFields(data, requireFields);
        if (missingFields.length > 0)
          throw new Error(
            `Faltan datos obligatorios para crear el inventory movement: ${missingFields.join(", ")}`
          );
        const { trx, ...movementData } = data;
        const inventoryMovement = await strapi.entityService.create(
          "api::inventory-movement.inventory-movement",
          {
            data: { ...movementData },
          },
          { transacting: trx }
        );
        return inventoryMovement;
      } catch (error) {
        throw error;
      }
    },
    async findMany(data) {
      try {
        const { filters = {}, populate = [], trx } = data;
        let transactingObj = {};
        if (trx) {
          transactingObj = { transacting: trx };
        }
        const inventoryMovements = await strapi.entityService.findMany(
          INVENTORY_MOVEMENT_SERVICE,
          {
            filters,
            populate,
            sort: [{ createdAt: "asc" }],
          },
          transactingObj
        );
        return inventoryMovements;
      } catch (error) {
        throw error;
      }
    },

    /**
     * Builds an inventory Kardex (quantity-only) for a fiscal year, grouped by
     * product and consolidated across all warehouses.
     *
     * For every product it computes the opening balance (net effect of all
     * physical movements before Jan 1 of the year, in Bogotá time), the
     * chronological list of movements during the year with a running balance,
     * and the closing balance. Logical movements (reserve/unreserve) are
     * excluded. Internal transfers are listed but do not change the
     * consolidated balance.
     *
     * To stay readable and scalable, the underlying item-level movements are
     * aggregated into one Kardex line per (product, document, type, day): the
     * quantities are summed and the number of underlying items is reported. The
     * source movements are read in pages so the method handles hundreds of
     * thousands of rows with low memory and without hitting the SQL parameter
     * limit.
     *
     * @param {Object} params
     * @param {number|string} params.year - Fiscal year (e.g. 2024).
     * @param {number|string} [params.productId] - Restrict to a single product.
     * @returns {Promise<{meta: Object, products: Array}>}
     */
    async buildKardex({ year, productId } = {}) {
      const y = parseInt(year, 10);
      if (!y || Number.isNaN(y)) {
        throw new Error(
          "El parámetro 'year' es obligatorio y debe ser un año válido (ej: 2024)."
        );
      }

      const yearStart = moment.tz(`${y}-01-01 00:00:00`, TZ);
      const yearEndExclusive = moment.tz(`${y + 1}-01-01 00:00:00`, TZ);

      const filters = {
        type: { $in: PHYSICAL_TYPES },
        createdAt: { $lt: yearEndExclusive.toISOString() },
      };
      if (productId) {
        filters.item = { product: { id: parseInt(productId, 10) } };
      }

      const products = {};
      let skippedNoProduct = 0;
      let processed = 0;

      // Ensures a product accumulator exists.
      const productAcc = (product) => {
        const pid = product.id;
        if (!products[pid]) {
          products[pid] = {
            productId: pid,
            code: product.code || "",
            name: product.name || "",
            unit: product.unit || "",
            opening: 0,
            buckets: new Map(),
          };
        }
        return products[pid];
      };

      // Paged read: avoids loading 100k+ rows at once (memory + SQL IN limit).
      const PAGE_SIZE = 10000;
      let start = 0;
      for (;;) {
        const page = await strapi.entityService.findMany(
          INVENTORY_MOVEMENT_SERVICE,
          {
            filters,
            populate: [
              "item",
              "item.product",
              "order",
              "order.customer",
              "order.supplier",
              "sourceWarehouse",
              "destinationWarehouse",
            ],
            sort: [{ createdAt: "asc" }, { id: "asc" }],
            start,
            limit: PAGE_SIZE,
          }
        );
        if (!page.length) break;

        for (const m of page) {
          const product = m.item && m.item.product;
          if (!product) {
            skippedNoProduct += 1;
            continue;
          }
          const P = productAcc(product);
          const delta = effectOf(m);
          const ts = moment.tz(m.createdAt, TZ);

          if (ts.isBefore(yearStart)) {
            P.opening += delta;
            continue;
          }

          const day = ts.format("YYYY-MM-DD");
          const orderId = m.order?.id || "-";
          const key = `${orderId}|${m.type}|${day}`;
          let b = P.buckets.get(key);
          if (!b) {
            const tercero = pickTercero(m.order);
            b = {
              firstTs: ts.valueOf(),
              day,
              type: m.type,
              document: m.order?.code || "",
              invoice: invoiceLabel(m.order),
              terceroNit: tercero.nit,
              terceroName: tercero.name,
              warehouses: new Set(),
              sumDelta: 0,
              transferAbs: 0,
              itemCount: 0,
            };
            P.buckets.set(key, b);
          }
          b.sumDelta += delta;
          b.itemCount += 1;
          if (m.type === INVENTORY_MOVEMENT_TYPES.TRANSFER) {
            b.transferAbs += Math.abs(Number(m.quantity) || 0);
          }
          const wh = warehouseLabel(m);
          if (wh) b.warehouses.add(wh);
          if (ts.valueOf() < b.firstTs) b.firstTs = ts.valueOf();
        }

        processed += page.length;
        if (page.length < PAGE_SIZE) break;
        start += PAGE_SIZE;
      }

      // Current physical on-hand per product (items not sold/dropped), for
      // reconciliation against the ledger closing balance. Aggregated at the DB
      // level so it scales regardless of the number of items.
      const stockByProduct = {};
      try {
        const knex = strapi.db.connection;
        const q = knex("items as i")
          .join("items_product_lnk as l", "l.item_id", "i.id")
          .whereNotIn("i.state", ["sold", "dropped"])
          .groupBy("l.product_id")
          .select("l.product_id as productId")
          .sum({ q: "i.current_quantity" });
        if (productId) q.where("l.product_id", parseInt(productId, 10));
        const stockRows = await q;
        stockRows.forEach((r) => {
          stockByProduct[r.productId] = Number(r.q) || 0;
        });
      } catch (e) {
        strapi.log.warn(
          `Kardex: no se pudo calcular el stock actual para reconciliación: ${e.message}`
        );
      }

      const result = Object.values(products).map((P) => {
        let saldo = P.opening;
        let totalIn = 0;
        let totalOut = 0;

        const buckets = Array.from(P.buckets.values()).sort(
          (a, b) => a.firstTs - b.firstTs
        );

        const rows = buckets.map((b) => {
          saldo += b.sumDelta;
          const entrada = b.sumDelta > 0 ? b.sumDelta : 0;
          const salida = b.sumDelta < 0 ? -b.sumDelta : 0;
          totalIn += entrada;
          totalOut += salida;

          const notesParts = [];
          if (b.transferAbs > 0) {
            notesParts.push(
              `Traslado interno (${b.transferAbs}) — no afecta el saldo consolidado`
            );
          }
          notesParts.push(`${b.itemCount} ítem(s)`);

          let warehouse = Array.from(b.warehouses);
          warehouse =
            warehouse.length > 2
              ? `${warehouse.slice(0, 2).join(", ")} +${warehouse.length - 2}`
              : warehouse.join(", ");

          return {
            date: b.day,
            type: TYPE_LABELS[b.type] || b.type,
            document: b.document,
            invoice: b.invoice,
            terceroNit: b.terceroNit,
            terceroName: b.terceroName,
            warehouse,
            unit: P.unit,
            entrada,
            salida,
            saldo,
            notes: notesParts.join(" · "),
          };
        });

        const currentStock = stockByProduct[P.productId] ?? 0;
        // Round to avoid float noise from summing decimals.
        const round = (n) => Math.round(n * 10000) / 10000;

        return {
          productId: P.productId,
          code: P.code,
          name: P.name,
          unit: P.unit,
          opening: round(P.opening),
          closing: round(saldo),
          totalIn: round(totalIn),
          totalOut: round(totalOut),
          currentStock: round(currentStock),
          difference: round(saldo - currentStock),
          movementCount: rows.length,
          rows: rows.map((r) => ({
            ...r,
            saldo: round(r.saldo),
            entrada: round(r.entrada),
            salida: round(r.salida),
          })),
        };
      });

      // Drop products that never moved within the year AND carry no balance.
      const filtered = result.filter(
        (p) => p.movementCount > 0 || p.opening !== 0 || p.closing !== 0
      );

      filtered.sort((a, b) =>
        (a.code || a.name || "").localeCompare(b.code || b.name || "", "es", {
          numeric: true,
        })
      );

      return {
        meta: {
          year: y,
          productId: productId ? parseInt(productId, 10) : null,
          generatedAt: new Date().toISOString(),
          timezone: TZ,
          totalProducts: filtered.length,
          totalLines: filtered.reduce((s, p) => s + p.movementCount, 0),
          sourceMovements: processed,
          skippedNoProduct,
          discrepancies: filtered.filter((p) => Math.abs(p.difference) >= 0.01)
            .length,
        },
        products: filtered,
      };
    },

    /**
     * Renders a Kardex (from {@link buildKardex}) into a styled .xlsx Buffer:
     * a "Resumen" sheet with per-product opening/in/out/closing, and a
     * "Kardex" sheet with the chronological detail per product.
     *
     * @param {{meta: Object, products: Array}} kardex
     * @returns {Promise<Buffer>}
     */
    async generateKardexExcel(kardex) {
      const ExcelJS = require("exceljs");
      const { meta, products } = kardex;

      const C = {
        dark: { argb: "FF27272A" },
        dark2: { argb: "FF3F3F46" },
        band: { argb: "FF1D4ED8" },
        lightGrey: { argb: "FFF0F0F0" },
        totalGrey: { argb: "FFE5E7EB" },
        altRow: { argb: "FFF9F9F9" },
        white: { argb: "FFFFFFFF" },
        green: { argb: "FF166534" },
        red: { argb: "FFB91C1C" },
      };
      const fill = (color) => ({
        type: "pattern",
        pattern: "solid",
        fgColor: color,
      });
      const thin = {
        top: { style: "thin", color: { argb: "FFD4D4D8" } },
        bottom: { style: "thin", color: { argb: "FFD4D4D8" } },
        left: { style: "thin", color: { argb: "FFD4D4D8" } },
        right: { style: "thin", color: { argb: "FFD4D4D8" } },
      };
      const numFmt = "#,##0.00";

      const wb = new ExcelJS.Workbook();
      wb.creator = "Adatex S.A.S";
      wb.created = new Date();

      let logoId = null;
      try {
        const logoBuffer = fs.readFileSync(
          path.resolve(__dirname, "../../../assets/logo.png")
        );
        logoId = wb.addImage({ buffer: logoBuffer, extension: "png" });
      } catch {
        /* logo opcional */
      }

      const generated = moment.tz(meta.generatedAt, TZ).format("YYYY-MM-DD HH:mm");

      // ── Hoja Resumen ────────────────────────────────────────────────────────
      const sum = wb.addWorksheet("Resumen");
      sum.columns = [
        { width: 16 },
        { width: 42 },
        { width: 8 },
        { width: 15 },
        { width: 14 },
        { width: 14 },
        { width: 15 },
        { width: 15 },
        { width: 14 },
        { width: 11 },
      ];
      const SUM_COLS = 10;

      sum.mergeCells(1, 1, 1, SUM_COLS);
      sum.getCell(1, 1).fill = fill(C.dark);
      sum.getRow(1).height = 38;
      if (logoId !== null) {
        sum.addImage(logoId, {
          tl: { col: 0, row: 0 },
          ext: { width: 220, height: 31 },
          editAs: "oneCell",
        });
      }

      sum.mergeCells(2, 1, 2, SUM_COLS);
      const sSub = sum.getCell(2, 1);
      sSub.value = `KARDEX DE INVENTARIO — TRAZABILIDAD ${meta.year}`;
      sSub.font = { bold: true, size: 12, color: C.white };
      sSub.fill = fill(C.dark2);
      sSub.alignment = { vertical: "middle", horizontal: "center" };
      sum.getRow(2).height = 24;

      sum.mergeCells(3, 1, 3, SUM_COLS);
      const sInfo = sum.getCell(3, 1);
      sInfo.value = `Año ${meta.year} (zona horaria ${meta.timezone})   |   ${meta.totalProducts} productos · ${meta.totalMovements} movimientos   |   Generado: ${generated}`;
      sInfo.font = { size: 9, italic: true, color: C.dark };
      sInfo.fill = fill(C.lightGrey);
      sInfo.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
      sum.getRow(3).height = 18;
      sum.getRow(4).height = 6;

      const sumHeaders = [
        "Código",
        "Producto",
        "Und",
        "Saldo inicial",
        "Entradas",
        "Salidas",
        "Saldo final",
        "Stock actual",
        "Diferencia",
        "# Líneas",
      ];
      let sr = 5;
      const shRow = sum.getRow(sr++);
      shRow.height = 18;
      sumHeaders.forEach((h, i) => {
        const c = shRow.getCell(i + 1);
        c.value = h;
        c.font = { bold: true, size: 9, color: C.white };
        c.fill = fill(C.dark);
        c.border = thin;
        c.alignment = {
          vertical: "middle",
          horizontal: i >= 3 ? "right" : "left",
          indent: i < 3 ? 1 : 0,
        };
      });

      products.forEach((p, idx) => {
        const r = sum.getRow(sr++);
        r.height = 15;
        const rowFill = fill(idx % 2 === 0 ? C.white : C.altRow);
        const hasDiff = Math.abs(p.difference) >= 0.01;
        const vals = [
          p.code,
          p.name,
          p.unit,
          p.opening,
          p.totalIn,
          p.totalOut,
          p.closing,
          p.currentStock,
          p.difference,
          p.movementCount,
        ];
        vals.forEach((v, i) => {
          const c = r.getCell(i + 1);
          c.value = v;
          c.fill = rowFill;
          c.border = thin;
          c.font = { size: 9, color: C.dark };
          if (i >= 3 && i <= 8) {
            c.numFmt = numFmt;
            c.alignment = { horizontal: "right" };
          } else if (i === 9) {
            c.alignment = { horizontal: "right" };
          } else {
            c.alignment = { horizontal: "left", indent: 1 };
          }
          // Resaltar diferencias ledger vs stock físico.
          if (i === 8 && hasDiff) {
            c.font = { size: 9, bold: true, color: C.red };
            c.fill = fill({ argb: "FFFEE2E2" });
          }
        });
      });
      sum.views = [{ state: "frozen", ySplit: 5 }];
      sum.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: SUM_COLS } };

      // ── Hoja Kardex (detalle) ───────────────────────────────────────────────
      const ws = wb.addWorksheet("Kardex");
      ws.columns = [
        { width: 16 }, // Fecha
        { width: 14 }, // Tipo
        { width: 16 }, // Documento
        { width: 14 }, // Factura DIAN
        { width: 16 }, // NIT
        { width: 34 }, // Tercero
        { width: 22 }, // Bodega
        { width: 8 }, // Unidad
        { width: 13 }, // Entrada
        { width: 13 }, // Salida
        { width: 14 }, // Saldo
        { width: 40 }, // Observaciones
      ];
      const COLS = 12;
      const detailHeaders = [
        "Fecha",
        "Tipo",
        "Documento",
        "Factura DIAN",
        "NIT Tercero",
        "Tercero",
        "Bodega",
        "Und",
        "Entrada",
        "Salida",
        "Saldo",
        "Observaciones",
      ];

      ws.mergeCells(1, 1, 1, COLS);
      ws.getCell(1, 1).fill = fill(C.dark);
      ws.getRow(1).height = 38;
      if (logoId !== null) {
        ws.addImage(logoId, {
          tl: { col: 0, row: 0 },
          ext: { width: 220, height: 31 },
          editAs: "oneCell",
        });
      }
      ws.mergeCells(2, 1, 2, COLS);
      const dSub = ws.getCell(2, 1);
      dSub.value = `KARDEX DE INVENTARIO — DETALLE CRONOLÓGICO ${meta.year}`;
      dSub.font = { bold: true, size: 12, color: C.white };
      dSub.fill = fill(C.dark2);
      dSub.alignment = { vertical: "middle", horizontal: "center" };
      ws.getRow(2).height = 24;
      ws.getRow(3).height = 6;

      let row = 4;

      const writeDetailHeader = () => {
        const hr = ws.getRow(row++);
        hr.height = 16;
        detailHeaders.forEach((h, i) => {
          const c = hr.getCell(i + 1);
          c.value = h;
          c.font = { bold: true, size: 8, color: C.white };
          c.fill = fill(C.dark);
          c.border = thin;
          c.alignment = {
            vertical: "middle",
            horizontal: i >= 8 && i <= 10 ? "right" : "left",
            indent: i < 8 ? 1 : 0,
          };
        });
      };

      const balanceRow = (label, value) => {
        const r = ws.getRow(row++);
        r.height = 15;
        ws.mergeCells(r.number, 1, r.number, 10);
        const lc = r.getCell(1);
        lc.value = label;
        lc.font = { bold: true, size: 9, color: C.dark };
        lc.fill = fill(C.totalGrey);
        lc.alignment = { horizontal: "right", indent: 1 };
        lc.border = thin;
        const vc = r.getCell(11);
        vc.value = value;
        vc.numFmt = numFmt;
        vc.font = { bold: true, size: 9, color: C.dark };
        vc.fill = fill(C.totalGrey);
        vc.alignment = { horizontal: "right" };
        vc.border = thin;
        ws.getCell(r.number, 12).fill = fill(C.totalGrey);
        ws.getCell(r.number, 12).border = thin;
      };

      products.forEach((p) => {
        // Banda de producto
        const band = ws.getRow(row++);
        band.height = 20;
        ws.mergeCells(band.number, 1, band.number, COLS);
        const bc = band.getCell(1);
        bc.value = `${p.code ? p.code + " — " : ""}${p.name}  (${p.unit})`;
        bc.font = { bold: true, size: 11, color: C.white };
        bc.fill = fill(C.band);
        bc.alignment = { vertical: "middle", horizontal: "left", indent: 1 };

        writeDetailHeader();
        balanceRow("Saldo inicial →", p.opening);

        p.rows.forEach((rowData, idx) => {
          const r = ws.getRow(row++);
          r.height = 14;
          const rowFill = fill(idx % 2 === 0 ? C.white : C.altRow);
          const vals = [
            rowData.date,
            rowData.type,
            rowData.document,
            rowData.invoice,
            rowData.terceroNit,
            rowData.terceroName,
            rowData.warehouse,
            rowData.unit,
            rowData.entrada || null,
            rowData.salida || null,
            rowData.saldo,
            rowData.notes,
          ];
          vals.forEach((v, i) => {
            const c = r.getCell(i + 1);
            c.value = v;
            c.fill = rowFill;
            c.border = thin;
            c.font = { size: 8, color: C.dark };
            if (i >= 8 && i <= 10) {
              c.numFmt = numFmt;
              c.alignment = { horizontal: "right" };
              if (i === 8 && v) c.font = { size: 8, color: C.green };
              if (i === 9 && v) c.font = { size: 8, color: C.red };
              if (i === 10) c.font = { size: 8, bold: true, color: C.dark };
            } else {
              c.alignment = { horizontal: "left", indent: 1, wrapText: i === 11 };
            }
          });
        });

        balanceRow("Saldo final →", p.closing);
        row++; // separador
      });

      ws.views = [{ state: "frozen", ySplit: 3 }];

      const buffer = await wb.xlsx.writeBuffer();
      return Buffer.from(buffer);
    },
  })
);
