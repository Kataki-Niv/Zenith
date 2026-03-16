import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("GEMINI_API_KEY missing");
}

const genAI = new GoogleGenerativeAI(apiKey);

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const {
      siteName,
      systemSizeKW,
      batteryKWh,
      irr,
      paybackYears,
      equityRequired,
      npv
    } = body;

    const prompt = `
You are Zenith AI, a solar finance analyst.

Analyze this rooftop solar investment model and explain the result in simple business terms.

Project:
Site: ${siteName}
System Size: ${systemSizeKW} kW
Battery Storage: ${batteryKWh} kWh
IRR: ${irr} %
Payback Period: ${paybackYears} years
Equity Required: ₹${equityRequired}
Net Present Value: ₹${npv}

Explain:
1. Whether this project is financially attractive
2. Why the IRR is strong or weak
3. Any risk factors
4. One improvement suggestion

Keep response under 120 words.
`;

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const result = await model.generateContent(prompt);

    const response = await result.response;
const text = response.text();

    return Response.json({ text });

  } catch (error) {
    console.error("🔥 Rooftop AI error:", error);

    return Response.json({
      text: "AI analysis unavailable right now."
    });
  }
}