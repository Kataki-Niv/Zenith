from pulp import LpMinimize, LpProblem, LpVariable, PULP_CBC_CMD

def optimize_energy(data):
    # Inputs
    solar_A = data["solar_A"]
    demand_A = data["demand_A"]
    demand_B = data["demand_B"]
    demand_C = data["demand_C"]
    battery_B = data["battery_B"]

    grid_price = data["grid_price"]
    p2p_price = data["p2p_price"]

    # Create problem
    prob = LpProblem("Energy_Optimization", LpMinimize)

    # Decision variables
    A_to_B = LpVariable("A_to_B", lowBound=0)
    A_to_C = LpVariable("A_to_C", lowBound=0)
    B_to_C = LpVariable("B_to_C", lowBound=0)

    grid_to_A = LpVariable("grid_to_A", lowBound=0)
    grid_to_B = LpVariable("grid_to_B", lowBound=0)
    grid_to_C = LpVariable("grid_to_C", lowBound=0)

    # Objective → minimize cost
    prob += (
        grid_price * (grid_to_A + grid_to_B + grid_to_C)
        + p2p_price * (A_to_B + A_to_C + B_to_C)
    )

    # Constraints

    # House A
    prob += solar_A + grid_to_A == demand_A + A_to_B + A_to_C

    # House B
    prob += A_to_B + battery_B + grid_to_B == demand_B + B_to_C

    # House C
    prob += A_to_C + B_to_C + grid_to_C == demand_C

    # Solve
    prob.solve(PULP_CBC_CMD(msg=0))

    # -----------------------------
    # NEW: Baseline + Savings Logic
    # -----------------------------

    optimized_cost = prob.objective.value()

    baseline_cost = (demand_A + demand_B + demand_C) * grid_price
    savings = baseline_cost - optimized_cost

    efficiency = (savings / baseline_cost) * 100 if baseline_cost != 0 else 0

    # Output
    return {
        "A_to_B": A_to_B.varValue,
        "A_to_C": A_to_C.varValue,
        "B_to_C": B_to_C.varValue,
        "grid_to_A": grid_to_A.varValue,
        "grid_to_B": grid_to_B.varValue,
        "grid_to_C": grid_to_C.varValue,
        "total_cost": optimized_cost,
        "baseline_cost": baseline_cost,
        "savings": savings,
        "efficiency_gain_percent": round(efficiency, 2)
    }