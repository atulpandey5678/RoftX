// prompts.example.js — RoftX Prompt System Structure
// Copy this file to prompts.js and fill in your own prompt templates.
// The real prompts.js is NOT committed to git (it contains proprietary IP).
// For production deployment: add prompts.js as a Secret File on Render.
//
// Each function receives interpolated variables and returns a full prompt string.

// ─── PROMPT 1: Trending Topic Suggestions ────────────────────────────────────
export function buildTopicSuggestionsPrompt(niche) {
  return `[Your topic suggestion prompt here. Variable: ${niche}]`;
}

// ─── PROMPT 2: Voice Analysis ────────────────────────────────────────────────
export function buildVoiceAnalysisPrompt(writingSample) {
  return `[Your voice analysis prompt here. Variable: ${writingSample}]`;
}

// ─── PROMPT 3: Hook Generator ─────────────────────────────────────────────────
export function buildHookGeneratorPrompt(niche, topic, voiceProfile, extra = '') {
  return `[Your hook generator prompt here. Variables: ${niche}, ${topic}, ${voiceProfile}, ${extra}]`;
}

// ─── PROMPT 4: Full Post Generator ───────────────────────────────────────────
export function buildFullPostPrompt(niche, topic, chosenHook, voiceProfile) {
  return `[Your post generator prompt here. Variables: ${niche}, ${topic}, ${chosenHook}, ${voiceProfile}]`;
}

// ─── PROMPT 5: Smart Refinement ──────────────────────────────────────────────
export function buildRefinementPrompt(currentPost, instruction, voiceProfile) {
  return `[Your refinement prompt here. Variables: ${currentPost}, ${instruction}, ${voiceProfile}]`;
}

// ─── PROMPT 6: Voice-Matched Regeneration ────────────────────────────────────
export function buildRegenerationPrompt(currentPost, niche, topic, voiceProfile) {
  return `[Your regeneration prompt here. Variables: ${currentPost}, ${niche}, ${topic}, ${voiceProfile}]`;
}
