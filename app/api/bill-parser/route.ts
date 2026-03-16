import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export async function POST(req: Request) {
  try {
    // 1️⃣ Read uploaded file
    const formData = await req.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return Response.json(
        { error: "No file uploaded" },
        { status: 400 }
      );
    }

    // 2️⃣ Convert file → base64 (Gemini requirement)
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // 3️⃣ Load Gemini Vision model
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
    });

    // 4️⃣ Strict prompt (VERY important)
    const prompt = `
You are reading an Indian electricity bill.

Extract ONLY the final monthly payable amount in INR.

Rules:
- Output ONLY a number.
- No symbols, no commas, no words.
- If unsure, estimate the final payable amount.
`;

    // 5️⃣ Send image + prompt to Gemini
    const result = await model.generateContent([
      {
        inlineData: {
          data: buffer.toString("base64"),
          mimeType: file.type,
        },
      },
      { text: prompt },
    ]);

    // 6️⃣ Clean Gemini response
    const text = result.response.text().trim();
    const amount = Number(text.replace(/[^\d]/g, ""));

    if (!amount || isNaN(amount)) {
      return Response.json(
        { error: "Unable to extract bill amount" },
        { status: 422 }
      );
    }

    // 7️⃣ Return result to frontend
    return Response.json({ monthlyBill: amount });

  } catch (error) {
    console.error("Bill parser error:", error);
    return Response.json(
      { error: "Bill parsing failed" },
      { status: 500 }
    );
  }
}
