import { exec } from "child_process";

export async function POST(req: Request): Promise<Response> {
  const data = await req.json();

  return new Promise<Response>((resolve) => {
    exec(
      `python lib/lumen/run.py "${JSON.stringify(data).replace(/"/g, '\\"')}"`,
      (error, stdout, stderr) => {
        if (error) {
          resolve(
            Response.json(
              {
                error: "Execution failed",
                details: stderr,
              },
              { status: 500 }
            )
          );
          return;
        }

        try {
          resolve(Response.json(JSON.parse(stdout)));
        } catch {
          resolve(
            Response.json(
              {
                error: "Invalid JSON output",
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
