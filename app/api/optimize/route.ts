export async function GET(): Promise<Response> {
  return Response.json({
    flows: [
      { from: "Home1", to: "Hub", amount: 5 },
      { from: "Hub", to: "Home3", amount: 4 },
      { from: "Home2", to: "Home4", amount: 3 },
      { from: "Home2B", to: "Hub", amount: 2 },
    ],
    savings: 800,
    efficiency: 82,
    beforeCost: 4200,
    afterCost: 3400,
  });
}
