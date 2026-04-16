import { execFile } from "child_process";

type LumenInput = {
  solar_A: number;
  demand_A: number;
  demand_B: number;
  demand_C: number;
  battery_B: number;
  grid_price: number;
  p2p_price: number;
};

export async function POST(req: Request): Promise<Response> {
  let payload: LumenInput;

  try {
    payload = (await req.json()) as LumenInput;
  } catch {
    return Response.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  return new Promise<Response>((resolve) => {
    execFile(
      "python",
      ["lib/lumen/run.py", JSON.stringify(payload)],
      { cwd: process.cwd() },
      (error, stdout, stderr) => {
        if (error) {
          resolve(
            Response.json(
              {
                error: "Failed to run optimization engine.",
                details: stderr || error.message,
              },
              { status: 500 }
            )
          );
          return;
        }

        try {
          const result = JSON.parse(stdout);

          if (result?.error) {
            resolve(
              Response.json(
                {
                  error: "Optimization engine returned an error.",
                  details: result.error,
                },
                { status: 500 }
              )
            );
            return;
          }

          resolve(Response.json(result));
        } catch {
          resolve(
            Response.json(
              {
                error: "Optimization engine returned invalid JSON.",
                raw: stdout,
              },
              { status: 500 }
            )
          );
        }
      }
    );
  });
}
