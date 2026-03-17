# Zenith

### Live Demo
https://zenith-64k24v6u3-kataki-nivs-projects.vercel.app/

**Zenith** is a full-stack decision intelligence platform designed to evaluate the **technical, financial, and policy feasibility of rooftop solar adoption**. The platform integrates financial modeling, government policy analysis, and AI-assisted rooftop assessment into a unified analytical workflow that helps households and organizations determine whether solar installation is economically viable and environmentally beneficial.

The system combines real-world parameters such as electricity tariffs, solar irradiance, panel efficiency, government subsidy structures, and long-term energy price trends to provide data-driven insights into renewable energy adoption. By bringing these variables together within a single platform, Zenith transforms complex energy, engineering, and financial information into **accessible decision-support intelligence for solar adoption**.

Zenith is conceptually aligned with global renewable energy initiatives such as the **One Sun One World One Grid (OSOWOG)** vision, which aims to interconnect solar energy resources across regions to enable continuous renewable power generation. While OSOWOG focuses on large-scale international grid integration, Zenith explores the **micro-level decision intelligence required for widespread rooftop solar adoption**, helping individual households and organizations evaluate their role in the broader transition toward decentralized renewable energy systems.

---

# Platform Overview

Adopting rooftop solar requires evaluating multiple interconnected factors including electricity consumption, installation cost, government incentives, environmental conditions, and long-term financial returns. These factors are often difficult to analyze without specialized technical knowledge.

Zenith addresses this challenge by providing a **multi-layered analytical platform** that evaluates solar feasibility from four complementary perspectives:

- Financial feasibility of solar installation
- Long-term investment performance and asset lifecycle
- Government incentive optimization
- Physical rooftop capacity and solar exposure

By combining engineering analysis, financial modeling, policy intelligence, and AI-assisted visualization, Zenith enables users to make **informed and data-driven renewable energy decisions**.

---

# Key Features

## Solar Feasibility Engine

The Solar Feasibility Engine evaluates whether installing rooftop solar panels is financially viable for a specific household or organization.

Users can manually enter their monthly electricity bill or upload an image of their electricity bill for **AI-assisted parsing**. Using this information, the system estimates:

- Optimal solar system size
- Number of panels required
- Installation cost
- Annual electricity savings
- Payback period
- Long-term profit over a 25-year system lifecycle

The results are presented through an interactive dashboard accompanied by AI-generated explanations that interpret financial metrics in plain language.

---

## Long-Term Solar Investment Simulator

This module models solar installations as **long-term infrastructure investments** rather than simple utility upgrades.

Using the outputs of the Solar Feasibility Engine, the simulator performs multi-year projections of system performance and financial returns. The model incorporates several real-world variables including:

- Electricity tariff escalation
- Solar panel degradation
- Battery storage integration
- Loan financing structures
- Operational costs
- Government tax incentives

The simulator calculates professional investment metrics such as:

- Net Present Value (NPV)
- Internal Rate of Return (IRR)
- Cumulative cash flows
- Investment payback period

These projections allow users to analyze rooftop solar systems as **renewable energy assets**.

---

## Government Subsidy Intelligence

Government incentives play a major role in accelerating renewable energy adoption. Zenith incorporates national and regional policy frameworks into its financial analysis.

The platform integrates programs such as India's **PM Surya Ghar Muft Bijli Yojana**, which provides subsidies for rooftop solar installations.

Zenith calculates:

- Central government subsidy eligibility
- State-level incentives
- Net installation cost after subsidies
- Updated payback period
- Subsidy coverage percentage

These insights help users understand how policy incentives affect the economic viability of solar installation.

---

## AI Rooftop Analysis and Visualization (Beta)

The final layer of Zenith evaluates the **physical feasibility of rooftop solar installation**.

Users can upload rooftop images or videos which are analyzed using computer vision techniques to estimate:

- Available roof area
- Obstruction-free solar panel zones
- Recommended solar system capacity

The system then simulates solar panel placement and energy generation through interactive visualization tools. Zenith models:

- Sunlight exposure
- Panel orientation
- Shading effects
- Estimated electricity production

This module provides users with a **visual and engineering-based understanding of rooftop solar potential**.

---

# Environmental Impact Analysis

Beyond financial analysis, Zenith estimates the **environmental impact of solar adoption**.

The platform calculates metrics such as:

- Estimated CO₂ emission reduction
- Fossil fuel displacement
- Long-term clean energy production

These projections highlight the broader sustainability benefits of rooftop solar systems.

---

# System Architecture

Zenith operates as a modular analytical platform in which multiple components evaluate different aspects of solar adoption. These modules interact to produce a unified feasibility analysis.

```
                ┌────────────────────┐
                │  User Inputs       │
                │  (Bill / Rooftop)  │
                └─────────┬──────────┘
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
        ▼                 ▼                 ▼
Solar Feasibility   Investment         Rooftop
Engine              Simulator          Analysis
        │                 │                 │
        └──────────┬──────┴──────┬──────────┘
                   ▼             ▼
             Subsidy Intelligence
                   │
                   ▼
         Unified Solar Decision Insights
```

This architecture allows Zenith to combine **financial modeling, engineering estimation, and policy intelligence** within a single decision-support workflow.

---

# Technology Stack

## Frontend
- Next.js
- React
- TypeScript
- TailwindCSS
- Framer Motion

## Data Visualization
- Recharts

## 3D Visualization
- Three.js
- React Three Fiber

## AI Integration
- Google Gemini API

## Backend
- Next.js API Routes
- Custom financial and solar energy modeling algorithms

## Deployment
- Vercel

---

# How the Platform Works

1. The user provides electricity consumption data or uploads an electricity bill.
2. Zenith estimates optimal solar system capacity and financial feasibility.
3. The investment simulator models long-term economic performance of the solar installation.
4. Government policy intelligence adjusts the analysis based on subsidy eligibility.
5. AI-assisted rooftop analysis evaluates physical installation feasibility.
6. The platform integrates these results into a comprehensive solar adoption assessment.

---

# Installation

Clone the repository:

```bash
git clone https://github.com/yourusername/Zenith.git
cd Zenith
```

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

The application will be available at:

```
http://localhost:3000
```

---

# Future Improvements

Possible future enhancements for the platform include:

- Integration with satellite rooftop imagery
- Real-time solar irradiance APIs
- Automated rooftop segmentation using computer vision
- International policy incentive databases
- Smart grid and utility tariff integration

---

# Contributors

- **Nivedana** — Full-stack development, platform architecture, backend logic  
- **Ayush** — UI design and interface contributions
