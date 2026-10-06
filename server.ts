import express from 'express';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '25mb' }));

// Server-side Gemini initialization
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// Helper for fallback models if a paid model fails
async function callWithFallback(fn: () => Promise<any>, fallbackFn: () => Promise<any>) {
  try {
    return await fn();
  } catch (err: any) {
    console.warn('Primary model call error, attempting fallback:', err?.message);
    return await fallbackFn();
  }
}

// --------------------------------------------------------------------------
// 1. GEMINI CHATBOT API (Multi-turn conversation with memory)
// --------------------------------------------------------------------------
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, model = 'gemini-3.8-flash', systemInstruction } = req.body;
    
    // Default system prompt tailored for Business Management & Accounting
    const sysInstruction = systemInstruction || 
      'You are the expert Executive AI Accounting & Business Management Assistant for Dil Mohammad Sohel Enterprise (DMS Enterprise). ' +
      'You assist the owner and staff with financial analytics, inventory optimization, accounting principles, profit & loss analysis, ' +
      'cash flow management, tax/VAT calculations, invoice drafting, and business growth strategies. ' +
      'Be professional, concise, encouraging, and accurate in all numerical calculations.';

    // Format contents for generateContent
    // messages: array of { role: 'user' | 'model', content: string }
    const contents = (messages || []).map((m: any) => ({
      role: m.role === 'model' || m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || m.text || '') }],
    }));

    if (contents.length === 0) {
      return res.status(400).json({ error: 'Messages cannot be empty' });
    }

    const selectedModel = model === 'gemini-3.1-pro-preview' ? 'gemini-3.1-pro-preview' :
                          model === 'gemini-3.1-flash-lite' ? 'gemini-3.1-flash-lite' :
                          'gemini-3.8-flash';

    const response = await callWithFallback(
      () => ai.models.generateContent({
        model: selectedModel,
        contents,
        config: {
          systemInstruction: sysInstruction,
          temperature: 0.7,
        },
      }),
      () => ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents,
        config: {
          systemInstruction: sysInstruction,
          temperature: 0.7,
        },
      })
    );

    res.json({
      reply: response.text || 'No response generated.',
      modelUsed: selectedModel,
    });
  } catch (error: any) {
    console.error('Chat API Error:', error);
    res.status(500).json({ error: error.message || 'Chat generation failed' });
  }
});

// --------------------------------------------------------------------------
// 2. SEARCH GROUNDING API (Google Search data with citations)
// --------------------------------------------------------------------------
app.post('/api/search-grounding', async (req, res) => {
  try {
    const { prompt, model = 'gemini-3.8-flash' } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const response = await callWithFallback(
      () => ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
        },
      }),
      () => ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
        },
      })
    );

    const text = response.text || '';
    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const webSources = groundingChunks
      .filter((c: any) => c.web && c.web.uri)
      .map((c: any) => ({
        title: c.web.title || c.web.uri,
        url: c.web.uri,
      }));

    res.json({
      text,
      sources: webSources,
      groundingChunks,
    });
  } catch (error: any) {
    console.error('Search Grounding Error:', error);
    res.status(500).json({ error: error.message || 'Search grounding failed' });
  }
});

// --------------------------------------------------------------------------
// 3. MAPS GROUNDING API (Google Maps locations, reviews, navigation)
// --------------------------------------------------------------------------
app.post('/api/maps-grounding', async (req, res) => {
  try {
    const { prompt, latLng } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const toolConfig: any = {};
    if (latLng && typeof latLng.latitude === 'number' && typeof latLng.longitude === 'number') {
      toolConfig.retrievalConfig = { latLng };
    }

    const response = await callWithFallback(
      () => ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          tools: [{ googleMaps: {} }],
          ...(Object.keys(toolConfig).length > 0 ? { toolConfig } : {}),
        },
      }),
      () => ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: prompt,
        config: {
          tools: [{ googleMaps: {} }],
          ...(Object.keys(toolConfig).length > 0 ? { toolConfig } : {}),
        },
      })
    );

    const text = response.text || '';
    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const mapPlaces = groundingChunks
      .filter((c: any) => c.maps)
      .map((c: any) => ({
        title: c.maps.title || 'Location Map',
        url: c.maps.uri,
        placeAnswerSources: c.maps.placeAnswerSources,
      }));

    res.json({
      text,
      places: mapPlaces,
      groundingChunks,
    });
  } catch (error: any) {
    console.error('Maps Grounding Error:', error);
    res.status(500).json({ error: error.message || 'Maps grounding failed' });
  }
});

// --------------------------------------------------------------------------
// 4. IMAGE GENERATION & EDITING API (Gemini / Imagen)
// --------------------------------------------------------------------------
app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt, imageBase64, mimeType = 'image/png', aspectRatio = '1:1' } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    let imageUrl = '';
    let description = '';

    // If an existing image was provided, this is an image editing task
    if (imageBase64) {
      const parts: any[] = [
        {
          inlineData: {
            data: imageBase64.replace(/^data:image\/[a-z]+;base64,/, ''),
            mimeType,
          },
        },
        { text: prompt },
      ];

      const response = await callWithFallback(
        () => ai.models.generateContent({
          model: 'gemini-3.1-flash-image',
          contents: { parts },
          config: {
            imageConfig: {
              aspectRatio: aspectRatio as any,
              imageSize: '1K',
            },
          },
        }),
        () => ai.models.generateContent({
          model: 'gemini-3.1-flash-lite-image',
          contents: { parts },
        })
      );

      const partsOut = response.candidates?.[0]?.content?.parts || [];
      for (const part of partsOut) {
        if (part.inlineData) {
          imageUrl = `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
        } else if (part.text) {
          description = part.text;
        }
      }
    } else {
      // Image creation task
      const response = await callWithFallback(
        () => ai.models.generateContent({
          model: 'gemini-3.1-flash-image',
          contents: { parts: [{ text: prompt }] },
          config: {
            imageConfig: {
              aspectRatio: aspectRatio as any,
              imageSize: '1K',
            },
          },
        }),
        () => ai.models.generateImages({
          model: 'imagen-3.0-generate-002',
          prompt,
          config: {
            numberOfImages: 1,
            aspectRatio: aspectRatio as any,
          },
        })
      );

      // Handle both generateContent (inlineData) and generateImages (generatedImages) responses
      if ((response as any).generatedImages?.[0]?.image?.imageBytes) {
        const bytes = (response as any).generatedImages[0].image.imageBytes;
        imageUrl = `data:image/png;base64,${bytes}`;
      } else if ((response as any).candidates?.[0]?.content?.parts) {
        for (const part of (response as any).candidates[0].content.parts) {
          if (part.inlineData) {
            imageUrl = `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
          } else if (part.text) {
            description = part.text;
          }
        }
      }
    }

    if (!imageUrl) {
      return res.status(500).json({ error: 'No image was generated. Please adjust the prompt.' });
    }

    res.json({
      imageUrl,
      description,
      prompt,
    });
  } catch (error: any) {
    console.error('Image Generation Error:', error);
    res.status(500).json({ error: error.message || 'Image generation failed' });
  }
});

// --------------------------------------------------------------------------
// 5. VITE INTEGRATION / STATIC ASSETS
// --------------------------------------------------------------------------
if (process.env.NODE_ENV !== 'production') {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.resolve(__dirname, 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
  });
}

app.listen(port, '0.0.0.0', () => {
  console.log(`Enterprise Accounting Server running on http://0.0.0.0:${port}`);
});
