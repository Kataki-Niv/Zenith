// Service 4 — Rooftop AI calculations

export type RooftopSolarInput = {
  recommendedKW: number;
};

export type RooftopSolarResult = {
  systemSizeKW: number;
  annualProduction: number;
  co2Reduction: number;
};

export function calculateRooftopSolar(
  input: RooftopSolarInput
): RooftopSolarResult {

  const { recommendedKW } = input;

  // India average solar yield
  const ANNUAL_KWH_PER_KW = 1435;

  const annualProduction =
    recommendedKW * ANNUAL_KWH_PER_KW;

  const CO2_PER_KWH = 0.82;

  const co2Reduction =
    annualProduction * CO2_PER_KWH / 1000;

  return {
    systemSizeKW: recommendedKW,
    annualProduction,
    co2Reduction
  };
}