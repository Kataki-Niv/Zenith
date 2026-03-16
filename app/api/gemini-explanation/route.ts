import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export async function POST(req: Request) {
  try {
    console.log("🔥 Gemini API route HIT");

    const body = await req.json();

    const {
      location,
      monthlyBill,
      systemSizeKW,
      paybackYears,
    } = body;

    // ✅ THIS IS THE PROMPT (the brain of Gemini)
const prompt = `
You are a senior solar energy advisor for Indian households.

User data (already calculated, do NOT question it):
- Location: ${location}
- Monthly electricity bill: ₹${monthlyBill}
- Recommended solar system size: ${systemSizeKW} kW
- Estimated payback period: ${paybackYears} years

Your task:
Explain the solar feasibility clearly and honestly.

Rules:
- First, state whether this is a GOOD, MODERATE, or POOR solar investment.
- Then explain WHY the payback period is ${paybackYears} years.
- Mention what happens AFTER the payback period (savings, reduced bills).
- Include 1 realistic limitation or expectation (maintenance, weather, usage change).

Style rules:
- Use simple language for a non-technical user.
- Use short sentences or bullet points.
- Be practical and India-specific.
- No emojis.
- No marketing or hype.
- Do not invent numbers or schemes.

Formatting rules:
- Do NOT use markdown.
- Do NOT use ** or * characters.
- Do NOT bold or italicize text.
- Write labels as plain text only (GOOD, MODERATE, POOR).

Limit: 5–6 concise lines maximum.
`;


    console.log("🧠 Gemini prompt:\n", prompt);

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    return Response.json({ text });
  } catch (error) {
    console.error("❌ Gemini error:", error);
    return Response.json(
      { text: "Unable to generate explanation at the moment." },
      { status: 500 }
    );
  }
}
