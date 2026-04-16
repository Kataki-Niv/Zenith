import sys
import json
from lp_model import optimize_energy

try:
    data = json.loads(sys.argv[1])
    result = optimize_energy(data)
    print(json.dumps(result))
except Exception as e:
    print(json.dumps({"error": str(e)}))