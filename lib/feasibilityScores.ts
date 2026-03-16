// frontend/lib/feasibilityScores.ts

export function getFeasibilityScore(location: string): number {
  if (!location) return 7.5;

  const loc = location.toLowerCase();

  if (loc.includes("rajasthan")) return 9.5;
  if (loc.includes("gujarat")) return 9.2;
  if (loc.includes("chennai")) return 9.0;
  if (loc.includes("hyderabad")) return 8.8;
  if (loc.includes("bangalore")) return 8.5;
  if (loc.includes("mumbai")) return 7.5;
  if (loc.includes("delhi")) return 7.0;
  if (loc.includes("kolkata")) return 7.2;

  return 7.5; // default fallback
}
export function getInvestmentLabel(paybackYears: number) {
  if (paybackYears <= 8) return "GOOD";
  if (paybackYears > 12) return "POOR";
  return "MODERATE";
}
