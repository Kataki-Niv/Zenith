# Zenith — AI-Powered Solar Feasibility & Analytics Platform

Zenith is a full-stack web application designed to evaluate the **technical feasibility, economic viability, and long-term benefits of rooftop solar installations** for residential users.

The platform combines **deterministic solar engineering calculations** with **AI-assisted explanations** to provide **transparent, interpretable, and data-driven recommendations**.  
AI is used strictly as a decision-support layer, while all feasibility and savings metrics are computed using explicit, auditable logic.

---

## Problem Statement

Many potential solar adopters struggle with:
- Unclear feasibility assessment
- Inaccurate or overly optimistic savings estimates
- Complex electricity bills
- Black-box AI recommendations

Zenith addresses these challenges by delivering **explainable feasibility scoring**, **realistic savings projections**, and **plain-language insights** that help users make informed solar adoption decisions.

---

##  Core Capabilities

### 🔹 Solar Feasibility & Savings Analysis
- Manual electricity usage input
- AI-assisted electricity bill parsing (image upload)
- Monthly and yearly cost savings estimation
- Investment feasibility scoring based on consumption and offset potential
- Natural-language explanation of results and recommendations

### 🔹 Future Solar Potential Analysis (Planned)
- Long-term financial benefit projection
- Multi-year cost vs savings comparison
- Scenario-based analysis for changing consumption patterns

### 🔹 Government Subsidy Insights (Planned)
- Policy-aware subsidy information
- Eligibility-based guidance for users
- Integration of incentive impact on ROI calculations

### 🔹 Rooftop Suitability Analysis (Planned)
- Location-aware feasibility assessment
- Roof readiness and suitability scoring
- Enhanced decision support for installation planning

---

##  System Design Philosophy

- **Explainability first** — every score and recommendation is interpretable
- **Deterministic core logic** — real calculations, no mock data
- **AI as an assistant, not a black box**
- **Modular architecture** for scalability and future expansion

---

## 🛠 Tech Stack

### Frontend
- Next.js (App Router)
- React with TypeScript
- Tailwind CSS
- Responsive, dashboard-based UI

### Backend & APIs
- Next.js API Routes
- FastAPI 
- Modular business-logic layer

### AI Integration
- Google Gemini API
- Used for:
  - Electricity bill understanding
  - Plain-language reasoning
  - User-friendly result explanations

---

## ⚙️ How the System Works

1. User inputs electricity consumption or uploads a bill image
2. The system computes:
   - Energy offset potential
   - Monthly and yearly savings
   - Investment feasibility score
3. AI generates an interpretable explanation of the results
4. The user receives a **transparent solar feasibility recommendation**

---

##  Project Structure (Simplified)

project-zenith/
├── frontend/
│   ├── app/
│   ├── components/
│   ├── lib/
│   └── api/
├── backend/        # FastAPI (planned)
├── docs/
└── README.md

---

##  Project Status

- ✅ Solar Feasibility & Savings Analysis implemented
- 🚧 Advanced analysis modules under development
- 🧩 Designed for production-ready deployment and extension

---

##  Author

**Nivedana Kataki**  
Computer Science / AI Student  

Interests:
- Full-stack system design
- Applied & explainable AI
- Sustainable energy technologies
