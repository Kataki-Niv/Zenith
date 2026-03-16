import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export async function POST(req: Request) {
  try {
    console.log("🔥 Subsidy Gemini route HIT");

    const body = await req.json();

const {
  location,
  monthlyBill,
  systemSizeKW,
  paybackYears,
  centralSubsidy,
  stateSubsidy,
  totalSubsidy,
  netSystemCost,
  subsidyCoverage
} = body;
const prompt = `
You are an expert solar financial advisor for Indian households.

User configuration:
Location: ${location}
System size: ${systemSizeKW} kW
Monthly electricity bill: ₹${monthlyBill}

Financial results from Zenith engine:
Central subsidy: ₹${centralSubsidy}
State subsidy: ₹${stateSubsidy}
Total subsidy: ₹${totalSubsidy}
Net system cost: ₹${netSystemCost}
Subsidy coverage: ${subsidyCoverage}%
Estimated payback: ${paybackYears} years

Task:
Explain the solar investment quality.

Instructions:
1. First classify investment as GOOD, MODERATE, or POOR.
2. Explain why the payback period occurs.
3. Explain the role of subsidies in reducing cost.
4. Mention one realistic limitation.
5. Mention what happens after payback.

Style:
Clear and professional.
Maximum 5 sentences.
No markdown or symbols.
`;

    console.log("🧠 Gemini Subsidy Prompt:\n", prompt);

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    return Response.json({ text });

  } catch (error) {
    console.error("❌ Gemini subsidy error:", error);

    return Response.json(
      { text: "Unable to generate subsidy explanation right now." },
      { status: 500 }
    );
  }
}