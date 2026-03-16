import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("GEMINI_API_KEY missing");
}

const genAI = new GoogleGenerativeAI(apiKey);

export async function POST(req: Request) {
  try {
    const { image } = await req.json();

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
    });

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: image,
        },
      },
      `
Analyze this rooftop image for solar installation.

Return ONLY JSON:

{
 "roofAreaSqFt": number,
 "recommendedKW": number,
 "obstacles": ["object1","object2"]
}
`,
    ]);

    const response = await result.response;
    const text = response.text();

    return Response.json({ text });

  } catch (error) {
    console.error("🔥 Rooftop vision error:", error);

    return Response.json({
      text: "{}"
    });
  }
}