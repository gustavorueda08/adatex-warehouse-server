const items = [
  { code: "MARSELLA-03", price: 5602.24, quantity: 100.7 },
  { code: "MARSELLA-04", price: 5602.24, quantity: 120.55 },
  { code: "MARSELLA-08", price: 5602.24, quantity: 114.35 },
  { code: "MARSELLA-06", price: 5602.24, quantity: 215.25 },
  { code: "ESN-03", price: 5640.61, quantity: 211.8 },
  { code: "ESN-04", price: 5640.61, quantity: 1354.95 }, // > 1.2M
  { code: "ESN-06", price: 5640.58, quantity: 344.6 }, // > 1.2M
  { code: "ESN-10", price: 5640.61, quantity: 674.3 }, // > 1.2M
];

// Re-calculate based on logs
// #1 Total: 564145.57
// #4 Total: 1205882.16 (Just barely over 1.2M?)
// wait 5602.24 * 215.25 = 1205882.16. Yes.

// Taxes
const IVA_RATE = 0.19;
// Test with 3% and 2.5%
const RETE_RATE_WRONG = 0.03;
const RETE_RATE_CORRECT = 0.025;

const THRESHOLD = 1200000;

function calculateInvoice(reteRate) {
  let subtotal = 0;
  let taxes = 0;
  let retentions = 0;

  console.log(`\n--- Calculation with Rete Rate: ${reteRate * 100}% ---`);

  items.forEach((item) => {
    const lineTotal = Math.round(item.price * item.quantity * 100) / 100;
    subtotal += lineTotal;

    // IVA (Always applies)
    const iva = Math.round(lineTotal * IVA_RATE * 100) / 100;
    taxes += iva;

    // Rete (Check threshold per item as per mapper logic)
    if (lineTotal >= THRESHOLD) {
      const rete = Math.round(lineTotal * reteRate * 100) / 100;
      // In mapper.js:
      // if (taxDef.use === "decrement") invoiceTaxes -= itemTaxAmount;
      // Wait, is Rete mapped as "product" tax or "subtotal" tax?
      // Log says: applicationType: 'product' for Retefuente.
      // So it is treated as product tax (decrement).
      taxes -= rete;
    }
  });

  subtotal = Math.round(subtotal * 100) / 100;
  taxes = Math.round(taxes * 100) / 100;

  const total = Math.round((subtotal + taxes) * 100) / 100;

  console.log(`Subtotal: ${subtotal}`);
  console.log(`Taxes (Net): ${taxes}`);
  console.log(`Total: ${total}`);
  return total;
}

const target = 28249823.32;

const val1 = calculateInvoice(RETE_RATE_WRONG);
const val2 = calculateInvoice(RETE_RATE_CORRECT);

console.log(`\nTarget from Siigo: ${target}`);
console.log(`Diff 3%: ${target - val1}`);
console.log(`Diff 2.5%: ${target - val2}`);
