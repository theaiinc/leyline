import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  quotas: {
    gemini: {
       requestsPerMinute: parseInt(process.env.GEMINI_QUOTA_RPM || '10', 10),
       requestsPerDay: parseInt(process.env.GEMINI_QUOTA_RPD || '1000', 10),
    },
    huggingface: {
        requestsPerMinute: parseInt(process.env.HF_QUOTA_RPM || '100', 10), // Example default
        requestsPerDay: parseInt(process.env.HF_QUOTA_RPD || '1000', 10),
    },
    openrouter: {
        requestsPerMinute: parseInt(process.env.OPENROUTER_QUOTA_RPM || '20', 10),
        requestsPerDay: parseInt(process.env.OPENROUTER_QUOTA_RPD || '200', 10),
    },
    ollama: {
        requestsPerMinute: 999999, // Effectively unlimited
        requestsPerDay: 999999
    }
  },
  DEFAULT_MODELS: {
      GEMINI: 'gemini-2.0-flash',
      HF: 'microsoft/Phi-3-mini-4k-instruct',
      OPENROUTER: 'mistralai/mistral-7b-instruct:free',
      OLLAMA: 'llama2'
  }
};
