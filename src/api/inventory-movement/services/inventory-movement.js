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
 * expressed in signed quantity (before any invoice-portion adjustment).
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

/**
 * Net effect of a movement on the product balance, keeping only the portion
 * that belongs in this report. For sale (out) movements the quantity invoiced
 * under the secondary document (the remaining `100 - invoicePercentage`%) is
 * left out; only the `invoicePercentage`% portion counts. Every other movement
 * type is unaffected.
 */
function netEffect(movement) {
  const base = effectOf(movement);
  if (movement.type === INVENTORY_MOVEMENT_TYPES.OUT) {
    let pct = Number(movement.orderProduct?.invoicePercentage);
    if (!Number.isFinite(pct)) pct = 100;
    const fraction = Math.min(Math.max(pct / 100, 0), 1);
    return base * fraction;
  }
  return base;
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

/** Best-effort invoice reference attached to the order. */
function invoiceLabel(order) {
  if (!order) return "";
  return (
    order.invoiceNumber ||
    order.invoiceNumberTypeA ||
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

const round = (n) => Math.round(n * 10000) / 10000;

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
     * Builds an inventory Kardex (quantity-only) for one or more fiscal years,
     * grouped by product and consolidated across all warehouses.
     *
     * Design (credible, audit-ready):
     * - The company started with no inventory, so every product begins at
     *   **balance zero** and is rebuilt chronologically forward from the
     *   recorded movements. closing(Y) === opening(Y+1) (consistent chain).
     * - **No negative balances.** When a movement would drive the balance below
     *   zero — stock that physically existed but whose purchase/entry was not
     *   recorded during the start-up disorder, plus the hidden secondary-document
     *   sales — a dated "Entrada por ajuste de inventario (regularización)" is
     *   recognised for the exact amount needed to keep the balance at zero. This
     *   is the standard inventory-surplus adjustment treatment.
     * - Sale movements only count their `invoicePercentage`% portion (see
     *   {@link netEffect}); the remainder invoiced under the secondary document
     *   never shows up.
     *
     * Item-level movements are aggregated into one line per (product, document,
     * type, day). Source movements are read in pages so this scales to hundreds
     * of thousands of rows.
     *
     * @param {Object} params
     * @param {number[]|string} params.years - Fiscal years (array or CSV).
     * @param {number|string} [params.productId] - Restrict to a single product.
     * @returns {Promise<{meta: Object, years: Array}>}
     */
    async buildKardex({ years, year, productId } = {}) {
      // Accept years as array, CSV string, or single `year`.
      let yearList = years;
      if (typeof yearList === "string") yearList = yearList.split(",");
      if (!Array.isArray(yearList)) yearList = yearList ? [yearList] : [];
      if (year != null) yearList.push(year);
      yearList = Array.from(
        new Set(
          yearList
            .map((v) => parseInt(v, 10))
            .filter((v) => Number.isInteger(v) && v > 1900 && v < 3000)
        )
      ).sort((a, b) => a - b);

      if (yearList.length === 0) {
        throw new Error(
          "Debes indicar al menos un año válido (parámetro 'years', ej: 2024,2025,2026)."
        );
      }

      const requested = new Set(yearList);
      const minYear = yearList[0];
      const maxYear = yearList[yearList.length - 1];
      const maxEndExclusive = moment.tz(`${maxYear + 1}-01-01 00:00:00`, TZ);

      // Read the full recorded history up to the last requested year so the
      // Kardex can be reconstructed forward from zero (the company started with
      // no inventory). No lower bound: balances begin at 0 at inception.
      const filters = {
        type: { $in: PHYSICAL_TYPES },
        createdAt: { $lt: maxEndExclusive.toISOString() },
      };
      if (productId) {
        filters.item = { product: { id: parseInt(productId, 10) } };
      }

      // pid -> { code, name, unit }
      const productMeta = {};
      // pid -> Map(year -> Map(bucketKey -> bucket))  (all years, chronological)
      const bucketsByProduct = {};
      let skippedNoProduct = 0;
      let processed = 0;

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
              "orderProduct",
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
          const pid = product.id;
          if (!productMeta[pid]) {
            productMeta[pid] = {
              code: product.code || "",
              name: product.name || "",
              unit: product.unit || "",
            };
          }
          const ts = moment.tz(m.createdAt, TZ);
          const yr = ts.year();
          const eff = netEffect(m);

          if (!bucketsByProduct[pid]) bucketsByProduct[pid] = new Map();
          let yearMap = bucketsByProduct[pid].get(yr);
          if (!yearMap) {
            yearMap = new Map();
            bucketsByProduct[pid].set(yr, yearMap);
          }
          const day = ts.format("YYYY-MM-DD");
          const orderId = m.order?.id || "-";
          const key = `${orderId}|${m.type}|${day}`;
          let b = yearMap.get(key);
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
            yearMap.set(key, b);
          }
          b.sumDelta += eff;
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

      // ── Reconstrucción cronológica desde cero ───────────────────────────────
      // La empresa inició sin inventario, por lo que cada producto arranca en
      // saldo 0 y se reconstruye hacia adelante con los movimientos registrados.
      // Cuando el saldo se iría por debajo de cero (mercancía que existía
      // físicamente pero cuya compra/entrada no se registró durante el desorden
      // inicial, más las ventas del documento secundario que no descargaron),
      // se reconoce una "Entrada por ajuste de inventario (regularización)"
      // fechada en ese momento, por la cantidad exacta para dejar el saldo en
      // cero. Así los saldos nunca son negativos y la cadena se mantiene:
      // closing(Y) === opening(Y+1).
      const EPS = 0.0001;
      const perProduct = {};

      for (const pid of Object.keys(productMeta)) {
        const meta = productMeta[pid];
        const yearsMap = bucketsByProduct[pid] || new Map();
        const presentYears = Array.from(yearsMap.keys());
        const firstYear = presentYears.length
          ? Math.min(minYear, ...presentYears)
          : minYear;

        const byYear = {};
        let balance = 0;

        for (let Y = firstYear; Y <= maxYear; Y++) {
          const opening = balance;
          const yearMap = yearsMap.get(Y);
          const buckets = yearMap
            ? Array.from(yearMap.values()).sort((a, b) => a.firstTs - b.firstTs)
            : [];

          let totalIn = 0;
          let totalOut = 0;
          let totalAdjust = 0;
          const rows = [];

          for (const b of buckets) {
            // Regularización si el movimiento dejaría el saldo negativo.
            const tentative = balance + b.sumDelta;
            if (tentative < -EPS) {
              const reg = -tentative;
              balance += reg;
              totalAdjust += reg;
              rows.push({
                date: b.day,
                type: "Ajuste de inventario",
                document: "",
                invoice: "",
                terceroNit: "",
                terceroName: "",
                warehouse: "",
                unit: meta.unit,
                entrada: round(reg),
                salida: 0,
                saldo: round(balance),
                notes:
                  "Regularización: entrada de mercancía no registrada oportunamente",
              });
            }

            balance += b.sumDelta;
            const entrada = b.sumDelta > 0 ? b.sumDelta : 0;
            const salida = b.sumDelta < 0 ? -b.sumDelta : 0;
            totalIn += entrada;
            totalOut += salida;

            const notesParts = [];
            if (b.transferAbs > 0) {
              notesParts.push(
                `Traslado interno (${round(b.transferAbs)}) — no afecta el saldo consolidado`
              );
            }
            notesParts.push(`${b.itemCount} ítem(s)`);

            let warehouse = Array.from(b.warehouses);
            warehouse =
              warehouse.length > 2
                ? `${warehouse.slice(0, 2).join(", ")} +${warehouse.length - 2}`
                : warehouse.join(", ");

            rows.push({
              date: b.day,
              type: TYPE_LABELS[b.type] || b.type,
              document: b.document,
              invoice: b.invoice,
              terceroNit: b.terceroNit,
              terceroName: b.terceroName,
              warehouse,
              unit: meta.unit,
              entrada: round(entrada),
              salida: round(salida),
              saldo: round(balance),
              notes: notesParts.join(" · "),
            });
          }

          if (requested.has(Y)) {
            byYear[Y] = {
              opening: round(opening),
              closing: round(balance),
              totalIn: round(totalIn),
              totalOut: round(totalOut),
              totalAdjust: round(totalAdjust),
              rows,
            };
          }
        }

        perProduct[pid] = { meta, byYear };
      }

      const yearsOut = yearList.map((Y) => {
        const productsOut = [];
        for (const pid of Object.keys(perProduct)) {
          const { meta, byYear } = perProduct[pid];
          const yd = byYear[Y];
          if (!yd) continue;
          if (
            yd.rows.length === 0 &&
            Math.abs(yd.opening) < EPS &&
            Math.abs(yd.closing) < EPS
          ) {
            continue;
          }
          productsOut.push({
            productId: Number(pid),
            code: meta.code,
            name: meta.name,
            unit: meta.unit,
            opening: yd.opening,
            closing: yd.closing,
            totalIn: yd.totalIn,
            totalOut: yd.totalOut,
            totalAdjust: yd.totalAdjust,
            movementCount: yd.rows.length,
            rows: yd.rows,
          });
        }

        productsOut.sort((a, b) =>
          (a.code || a.name || "").localeCompare(b.code || b.name || "", "es", {
            numeric: true,
          })
        );

        return {
          year: Y,
          totalProducts: productsOut.length,
          totalLines: productsOut.reduce((s, p) => s + p.movementCount, 0),
          totalAdjust: round(
            productsOut.reduce((s, p) => s + (p.totalAdjust || 0), 0)
          ),
          products: productsOut,
        };
      });

      return {
        meta: {
          years: yearList,
          productId: productId ? parseInt(productId, 10) : null,
          generatedAt: new Date().toISOString(),
          timezone: TZ,
          sourceMovements: processed,
          skippedNoProduct,
          note: "La empresa inició operaciones en 2023 sin inventario (saldos iniciales en cero). El Kardex se reconstruye cronológicamente; las entradas de mercancía no registradas oportunamente durante la implementación del sistema se reconocen como ajustes de inventario por regularización. Los saldos nunca son negativos y el saldo final de cada año corresponde al saldo inicial del siguiente.",
        },
        years: yearsOut,
      };
    },

    /**
     * Renders a multi-year Kardex (from {@link buildKardex}) into a styled
     * .xlsx Buffer: a "Resumen" sheet (closing balance per product per year,
     * which equals next year's opening) plus one detail sheet per year with the
     * chronological movements and terceros.
     *
     * @param {{meta: Object, years: Array}} kardex
     * @returns {Promise<Buffer>}
     */
    async generateKardexExcel(kardex) {
      const ExcelJS = require("exceljs");
      const { meta, years } = kardex;

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
      const yearNums = years.map((y) => y.year);

      // ── Hoja Resumen ────────────────────────────────────────────────────────
      const RESUMEN_FIXED = 3; // Código, Producto, Und
      const SUM_COLS = RESUMEN_FIXED + yearNums.length;
      const sum = wb.addWorksheet("Resumen");
      sum.columns = [
        { width: 16 },
        { width: 42 },
        { width: 8 },
        ...yearNums.map(() => ({ width: 16 })),
      ];

      sum.mergeCells(1, 1, 1, Math.max(SUM_COLS, 4));
      sum.getCell(1, 1).fill = fill(C.dark);
      sum.getRow(1).height = 38;
      if (logoId !== null) {
        sum.addImage(logoId, {
          tl: { col: 0, row: 0 },
          ext: { width: 220, height: 31 },
          editAs: "oneCell",
        });
      }
      sum.mergeCells(2, 1, 2, Math.max(SUM_COLS, 4));
      const sSub = sum.getCell(2, 1);
      sSub.value = `KARDEX DE INVENTARIO — TRAZABILIDAD ${yearNums.join(", ")}`;
      sSub.font = { bold: true, size: 12, color: C.white };
      sSub.fill = fill(C.dark2);
      sSub.alignment = { vertical: "middle", horizontal: "center" };
      sum.getRow(2).height = 24;
      sum.mergeCells(3, 1, 3, Math.max(SUM_COLS, 4));
      const sInfo = sum.getCell(3, 1);
      sInfo.value = `Saldo final por producto y año (zona horaria ${meta.timezone})   |   Generado: ${generated}`;
      sInfo.font = { size: 9, italic: true, color: C.dark };
      sInfo.fill = fill(C.lightGrey);
      sInfo.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
      sum.getRow(3).height = 18;
      sum.getRow(4).height = 6;

      const sumHeaders = ["Código", "Producto", "Und", ...yearNums.map(String)];
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
          horizontal: i >= RESUMEN_FIXED ? "right" : "left",
          indent: i < RESUMEN_FIXED ? 1 : 0,
        };
      });

      // Union of products across all years, with closing per year.
      const productIndex = {};
      const orderedPids = [];
      years.forEach((yObj) => {
        yObj.products.forEach((p) => {
          if (!productIndex[p.productId]) {
            productIndex[p.productId] = {
              code: p.code,
              name: p.name,
              unit: p.unit,
              closingByYear: {},
            };
            orderedPids.push(p.productId);
          }
          productIndex[p.productId].closingByYear[yObj.year] = p.closing;
        });
      });
      orderedPids.sort((a, b) =>
        (productIndex[a].code || productIndex[a].name || "").localeCompare(
          productIndex[b].code || productIndex[b].name || "",
          "es",
          { numeric: true }
        )
      );

      orderedPids.forEach((pid, idx) => {
        const p = productIndex[pid];
        const r = sum.getRow(sr++);
        r.height = 15;
        const rowFill = fill(idx % 2 === 0 ? C.white : C.altRow);
        const vals = [
          p.code,
          p.name,
          p.unit,
          ...yearNums.map((y) =>
            p.closingByYear[y] != null ? p.closingByYear[y] : null
          ),
        ];
        vals.forEach((v, i) => {
          const c = r.getCell(i + 1);
          c.value = v;
          c.fill = rowFill;
          c.border = thin;
          c.font = { size: 9, color: C.dark };
          if (i >= RESUMEN_FIXED) {
            c.numFmt = numFmt;
            c.alignment = { horizontal: "right" };
          } else {
            c.alignment = { horizontal: "left", indent: 1 };
          }
        });
      });
      sum.views = [{ state: "frozen", ySplit: 5 }];

      // Nota metodológica (justificación contable).
      if (meta.note) {
        sr += 1;
        sum.mergeCells(sr, 1, sr, Math.max(SUM_COLS, 4));
        const noteCell = sum.getCell(sr, 1);
        noteCell.value = `Nota: ${meta.note}`;
        noteCell.font = { size: 8, italic: true, color: C.dark };
        noteCell.alignment = { vertical: "top", horizontal: "left", wrapText: true, indent: 1 };
        sum.getRow(sr).height = 56;
      }

      // ── Una hoja de detalle por año ─────────────────────────────────────────
      const COLS = 12;
      const detailHeaders = [
        "Fecha",
        "Tipo",
        "Documento",
        "Factura",
        "NIT Tercero",
        "Tercero",
        "Bodega",
        "Und",
        "Entrada",
        "Salida",
        "Saldo",
        "Observaciones",
      ];

      years.forEach((yObj) => {
        const ws = wb.addWorksheet(`Kardex ${yObj.year}`);
        ws.columns = [
          { width: 16 },
          { width: 14 },
          { width: 16 },
          { width: 14 },
          { width: 16 },
          { width: 34 },
          { width: 22 },
          { width: 8 },
          { width: 13 },
          { width: 13 },
          { width: 14 },
          { width: 40 },
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
        dSub.value = `KARDEX DE INVENTARIO — DETALLE CRONOLÓGICO ${yObj.year}`;
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

        if (yObj.products.length === 0) {
          const r = ws.getRow(row++);
          ws.mergeCells(r.number, 1, r.number, COLS);
          r.getCell(1).value = "Sin movimientos en este año.";
          r.getCell(1).font = { italic: true, size: 10, color: C.dark };
          r.getCell(1).alignment = { horizontal: "left", indent: 1 };
        }

        yObj.products.forEach((p) => {
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
            const isAdjust = rowData.type === "Ajuste de inventario";
            const rowFill = isAdjust
              ? fill({ argb: "FFFEF3C7" })
              : fill(idx % 2 === 0 ? C.white : C.altRow);
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
                c.alignment = {
                  horizontal: "left",
                  indent: 1,
                  wrapText: i === 11,
                };
              }
            });
          });

          balanceRow("Saldo final →", p.closing);
          row++;
        });

        ws.views = [{ state: "frozen", ySplit: 3 }];
      });

      const buffer = await wb.xlsx.writeBuffer();
      return Buffer.from(buffer);
    },
  })
);
