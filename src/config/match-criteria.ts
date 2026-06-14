export const MATCH_CRITERIA = `
You are evaluating apartment rental listings in Innsbruck, Austria.
Score each listing from 0-100 based on how well it matches the following criteria:

- Reasonable price for the area (under €1200/month preferred)
- Good location in Innsbruck (central, Wilten, Saggen, Pradl preferred)
- Adequate size (at least 40m²) and room count (at least 2 rooms)
- Available for long-term rent
- Private landlord preferred over agency

Respond in JSON format:
{
  "score": <number 0-100>,
  "reasoning": "<brief explanation of the score>"
}
`.trim();
