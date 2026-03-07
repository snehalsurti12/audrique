# Agentforce Parallel Call Testing — Narration Script

## What This Is (10 seconds)

This is an automated end-to-end test for Salesforce Agentforce — the AI-powered virtual agent that handles customer calls without human agents. We're verifying that Agentforce can handle multiple simultaneous calls from different telephony providers.

## What We're Testing (10 seconds)

Two calls are placed at the same time to the same Agentforce entry point. The first call comes from Amazon Connect CCP — the standard contact center softphone. The second call is placed through Twilio's REST API. Both calls reach Agentforce, which responds with an AI greeting: "Hi, I'm an AI service assistant. How can I help you?" We then verify in the Salesforce Command Center supervisor tab that both active conversations appear — confirming Agentforce is handling two concurrent calls from two different providers.

## Why This Matters (5 seconds)

Before deploying Agentforce in production, you need proof that it scales — that it doesn't drop calls, that it handles concurrent conversations, and that the supervisor dashboard accurately reflects what's happening in real time. This test provides that proof automatically, with no manual effort.

## What's Coming Next (5 seconds)

The next phase takes this further — instead of just placing calls and listening, we'll simulate a full customer conversation. An AI caller powered by an LLM will speak to Agentforce over voice, asking about billing issues, requesting refunds, and verifying that Agentforce follows the correct topic flows and updates Salesforce records. AI testing AI — end to end.
