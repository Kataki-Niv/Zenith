// Zenith — Service 1 solar calculations

export type SolarCalculationInput = {
  monthlyBill: number;
  tariffPerKWh: number;
  offsetFactor: number;
  feasibilityScore: number;
};

export type SolarCalculationResult = {
  systemSizeKW: number;
  numberOfPanels: number;
  installationCost: number;
  annualSavings: number;
  paybackYears: number;
  lifetimeProfit: number;
  feasibilityScore: number;
};

export function calculateSolarBenefits(
  input: SolarCalculationInput
): SolarCalculationResult {
  const {
    monthlyBill,
    tariffPerKWh,
    offsetFactor,
    feasibilityScore,
  } = input;

  /* -------------------------
     1. Electricity usage
  -------------------------- */
  const monthlyKWh = monthlyBill / tariffPerKWh;
  const dailyKWh = monthlyKWh / 30;

  /* -------------------------
     2. Production efficiency
     (realistic lower bound)
  -------------------------- */
  const rawEfficiency = feasibilityScore / 10;
  const efficiency = Math.max(rawEfficiency, 0.7);

  /* -------------------------
     3. Solar generation
  -------------------------- */
  const IDEAL_PRODUCTION_PER_KW = 4.5; // India avg (kWh/day)
  const productionPerKW =
    IDEAL_PRODUCTION_PER_KW * efficiency;

  /* -------------------------
     4. System sizing
  -------------------------- */
  const rawSystemSizeKW = dailyKWh / productionPerKW;
  const bufferedSystemSizeKW =
    rawSystemSizeKW * 1.15;

  /* -------------------------
     5. Panel sizing
  -------------------------- */
  const PANEL_SIZE_KW = 0.55;
  const numberOfPanels = Math.ceil(
    bufferedSystemSizeKW / PANEL_SIZE_KW
  );
  const systemSizeKW = numberOfPanels * PANEL_SIZE_KW;

  /* -------------------------
     6. Tiered installation cost
     (economy of scale)
  -------------------------- */
  let costPerKW = 65000;
  if (systemSizeKW > 2) costPerKW = 60000;
  if (systemSizeKW > 5) costPerKW = 52000;

  const FIXED_INSTALLATION_COST = 25000;

  const installationCost =
    systemSizeKW * costPerKW +
    FIXED_INSTALLATION_COST;

  /* -------------------------
     7. Annual savings
  -------------------------- */
  const grossAnnualSavings =
    monthlyBill * 12 * offsetFactor;

  const annualMaintenanceCost =
    installationCost * 0.01;

  const netAnnualSavings =
    grossAnnualSavings - annualMaintenanceCost;

  /* -------------------------
     8. Payback period
  -------------------------- */
  const paybackYears =
    installationCost / netAnnualSavings;

  /* -------------------------
     9. Lifetime profit
     (average degradation)
  -------------------------- */
  const SYSTEM_LIFETIME_YEARS = 25;
  const DEGRADATION_FACTOR = 0.9;

  const lifetimeSavings =
    netAnnualSavings *
    SYSTEM_LIFETIME_YEARS *
    DEGRADATION_FACTOR;

  const lifetimeProfit =
    lifetimeSavings - installationCost;

  return {
    systemSizeKW,
    numberOfPanels,
    installationCost: Math.round(installationCost),
    annualSavings: Math.round(netAnnualSavings),
    paybackYears,
    lifetimeProfit: Math.round(lifetimeProfit),
    feasibilityScore,
  };
}
