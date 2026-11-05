export type PlaygroundMode = 'chat' | 'speech' | 'transcription' | 'embeddings' | 'image' | 'video';

export type PlaygroundCapabilities = {
    chat?: boolean;
    vision?: boolean;
    speech?: boolean;
    transcription?: boolean;
    embeddings?: boolean;
    image?: boolean;
    video?: boolean;
  };

export type PlaygroundModel = {
    id: string;
    name?: string;
    provider?: string;
    description?: string;
    capabilities?: PlaygroundCapabilities;
    price?: { input?: number; output?: number };
  };

export function modesForModel(model: PlaygroundModel): PlaygroundMode[] {
    const capabilities = model.capabilities ?? {};
    const modes: PlaygroundMode[] = [];
    if (capabilities.chat !== false && (capabilities.chat || capabilities.vision)) modes.push('chat');
    if (capabilities.speech) modes.push('speech');
    if (capabilities.transcription) modes.push('transcription');
    if (capabilities.embeddings) modes.push('embeddings');
    if (capabilities.image) modes.push('image');
    if (capabilities.video) modes.push('video');
    return modes;
  }

export function modeLabel(mode: PlaygroundMode): string {
    return ({ chat: 'Chat', speech: 'Speech', transcription: 'Transcription', embeddings: 'Embeddings', image: 'Image', video: 'Video' })[mode];
  }

export function maskedCodeSnippets(mode: PlaygroundMode, model: string, input: string): { curl: string; python: string; javascript: string } {
    const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (mode === 'speech') {
      const body = `{"model":"${model}","input":"${escaped}","voice":"alloy","response_format":"mp3"}`;
      return {
        curl: `curl https://llm.valefront.com/v1/audio/speech -H "Authorization: Bearer $VALEFRONT_API_KEY" -H "Content-Type: application/json" -d '${body}'`,
        python: `from openai import OpenAI\nclient = OpenAI(api_key="$VALEFRONT_API_KEY", base_url="https://llm.valefront.com/v1")\nwith open("speech.mp3", "wb") as f:\n    f.write(client.audio.speech.create(model="${model}", voice="alloy", input="${escaped}").content)`,
        javascript: `const response = await fetch("https://llm.valefront.com/v1/audio/speech", { method: "POST", headers: { Authorization: "Bearer $VALEFRONT_API_KEY", "Content-Type": "application/json" }, body: JSON.stringify(${body}) });`,
      };
    }
    if (mode === 'transcription') {
      return {
        curl: `curl https://llm.valefront.com/v1/audio/transcriptions -H "Authorization: Bearer $VALEFRONT_API_KEY" -F model=${model} -F file=@recording.mp3`,
        python: `from openai import OpenAI\nclient = OpenAI(api_key="$VALEFRONT_API_KEY", base_url="https://llm.valefront.com/v1")\nwith open("recording.mp3", "rb") as audio:\n    print(client.audio.transcriptions.create(model="${model}", file=audio).text)`,
        javascript: `const form = new FormData(); form.append("model", "${model}"); form.append("file", audioFile); await fetch("https://llm.valefront.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer $VALEFRONT_API_KEY" }, body: form });`,
      };
    }
    if (mode === 'embeddings') {
      const body = `{"model":"${model}","input":"${escaped}"}`;
      return {
        curl: `curl https://llm.valefront.com/v1/embeddings -H "Authorization: Bearer $VALEFRONT_API_KEY" -H "Content-Type: application/json" -d '${body}'`,
        python: `from openai import OpenAI\nclient = OpenAI(api_key="$VALEFRONT_API_KEY", base_url="https://llm.valefront.com/v1")\nprint(client.embeddings.create(model="${model}", input="${escaped}").data[0].embedding[:8])`,
        javascript: `await fetch("https://llm.valefront.com/v1/embeddings", { method: "POST", headers: { Authorization: "Bearer $VALEFRONT_API_KEY", "Content-Type": "application/json" }, body: JSON.stringify(${body}) });`,
      };
    }
    if (mode === 'image' || mode === 'video') {
      const endpoint = mode === 'image' ? '/v1/images/generations' : '/v1/videos/generations';
      const body = `{"model":"${model}","prompt":"${escaped}"}`;
      return {
        curl: `curl https://llm.valefront.com${endpoint} -H "Authorization: Bearer $VALEFRONT_API_KEY" -H "Content-Type: application/json" -d '${body}'`,
        python: `import requests\nresponse = requests.post("https://llm.valefront.com${endpoint}", headers={"Authorization": "Bearer $VALEFRONT_API_KEY"}, json=${body})\nresponse.raise_for_status()\nprint(response.json())`,
        javascript: `await fetch("https://llm.valefront.com${endpoint}", { method: "POST", headers: { Authorization: "Bearer $VALEFRONT_API_KEY", "Content-Type": "application/json" }, body: JSON.stringify(${body}) });`,
      };
    }
    const body = `{"model":"${model}","messages":[{"role":"user","content":"${escaped}"}]}`;
    return {
      curl: `curl https://llm.valefront.com/v1/chat/completions -H "Authorization: Bearer $VALEFRONT_API_KEY" -H "Content-Type: application/json" -d '${body}'`,
      python: `from openai import OpenAI\nclient = OpenAI(api_key="$VALEFRONT_API_KEY", base_url="https://llm.valefront.com/v1")\nprint(client.chat.completions.create(model="${model}", messages=[{"role": "user", "content": "${escaped}"}]).choices[0].message.content)`,
      javascript: `await fetch("https://llm.valefront.com/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer $VALEFRONT_API_KEY", "Content-Type": "application/json" }, body: JSON.stringify(${body}) });`,
    };
  }

export function formatRunCost(cost: number | undefined): string {
    return cost === undefined ? 'price not published' : `$${cost.toFixed(6)}`;
  }