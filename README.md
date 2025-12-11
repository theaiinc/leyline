# Leyline 🔮

**The ultimate cost-optimizing LLM load balancer & gateway.**

Leyline is a resilient, smart AI Router that unifies multiple cost-effective LLM providers (Gemini, HuggingFace, OpenRouter, and local Ollama) into a single, reliable API. It intelligently routes requests, handles failover, manages rate limits, and optimizes costs so you can focus on building agents.

![Dashboard Preview](https://raw.githubusercontent.com/theaiinc/leyline/main/dashboard-preview.png)

## ✨ Key Features

*   **🛡️ Resilient Routing**: Automatically falls back to the next provider if one fails or hits rate limits.
*   **🌊 Seamless Streaming**: Recovers from mid-stream failures by stitching context transparently. Your users never see a crash.
*   **🧠 Smart Model Selection**: Request `model: "auto"` and Leyline picks the optimal cost-effective model for each provider (e.g. `gemini-1.5-flash`, `llama-3-70b`).
*   **📊 Real-time Dashboard**: Monitor network status, rate limits, and request logs at `/dashboard`.
*   **📈 Agent Analytics**: Insights into "Most Popular", "Fastest", and "Highest Quality" (Elo-rated) models.
*   **🔍 Model Discovery**: Search and filter through thousands of available models from connected providers with rich metadata.
*   **🔌 OpenAI Compatible**: Drop-in replacement for OpenAI SDKs (`/v1/chat/completions`).

## 📦 Installation

```bash
npm install @theaiinc/leyline
```

## 🚀 Quick Start

### 1. Standalone Server

Create a `.env` file with your keys:

```bash
# .env
GEMINI_API_KEY=your_key
HF_API_KEY=your_key
OPENROUTER_API_KEY=your_key
# Ollama is supported out of the box at http://localhost:11434
```

Run the router:

```bash
npx @theaiinc/leyline
```

The API will be available at `http://localhost:3000`.

### 2. Usage as a Library

```typescript
import { Router, GeminiProvider, OpenRouterProvider } from '@theaiinc/leyline';

// Initialize providers
const router = new Router([
  new GeminiProvider(process.env.GEMINI_API_KEY),
  new OpenRouterProvider(process.env.OPENROUTER_API_KEY)
]);

// Make a request (Standard)
const response = await router.route({
  model: 'auto', // Smart selection
  messages: [{ role: 'user', content: 'Hello!' }]
});

console.log(response.choices[0].message.content);

// Make a request (Streaming)
for await (const chunk of router.routeStream({
  model: 'mistralai/mistral-7b-instruct',
  messages: [{ role: 'user', content: 'Tell me a story.' }]
})) {
  process.stdout.write(chunk.choices[0].delta.content || '');
}
```

## 🖥️ Dashboard

Access the dashboard at `http://localhost:3000/dashboard` to view:

*   **Network Status**: Real-time quota usage and provider health.
*   **Model Explorer**: Searchable list of all available models with descriptions and specs.
*   **Leaderboards**:
    *   **🏆 Usage**: Your most frequent models.
    *   **⚡ Latency**: Fastest response times.
    *   **🌟 Quality**: Models ranked by LMSYS Elo ratings (GPT-4o, Claude 3.5, etc.).

## 🛠️ Configuration

Leyline supports standard `.env` configuration:

| Variable | Description |
| :--- | :--- |
| `PORT` | Server port (default: 3000) |
| `GEMINI_API_KEY` | Google AI Studio Key |
| `HF_API_KEY` | Hugging Face Access Token |
| `OPENROUTER_API_KEY` | OpenRouter API Key |

## 🤝 Contributing

We welcome contributions! Please feel free to submit a Pull Request.

## 📄 License

Proprietary. Free to use.

© 2025 The AI Inc. All rights reserved.
