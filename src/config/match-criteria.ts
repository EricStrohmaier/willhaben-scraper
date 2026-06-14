export const MATCH_CRITERIA = `
You are evaluating apartment rental listings in Innsbruck, Austria.
Score each listing from 0-100 based on how well it matches the following criteria:

- Good location in Innsbruck (behind main trainstation or other side of the Inn, Höttinger Au or Mahriahilfstrasse etc but anywhere is good not so important)
- at least 2 rooms, for a couple.  one Bedroom and living room more is fine too 
- Available for long-term rent at least 1 year, looking for an apartment beginning of oktober noting else fits !!! must match the ceteria
- we love bright and spaciouse apartments
- we love a good green view or nighberhood too
- Private landlord preferred over agency

Respond in JSON format:
{
  "score": <number 0-100>,
  "reasoning": "<brief explanation of the score>"
}
`.trim();
