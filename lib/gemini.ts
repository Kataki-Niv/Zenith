// frontend/lib/gemini.ts

export async function getGeminiExplanation(input: {
  location: string;
  monthlyBill: number;
  systemSizeKW: number;
  paybackYears: number;
}) {
  const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("Gemini API key missing");
  }

  const prompt = `
Explain this solar analysis to a normal Indian household user:

Location: ${input.location}
Monthly electricity bill: ₹${input.monthlyBill}
Recommended system size: ${input.systemSizeKW.toFixed(2)} kW
Payback period: ${input.paybackYears.toFixed(1)} years

Explain clearly, simply, and realistically.
  `;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
      }),
    }
  );

  const data = await res.json();

  return (
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    "AI explanation unavailable."
  );
}
