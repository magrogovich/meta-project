import { z } from "zod";
export const CriterionSchema = z.object({ id: z.string(), name: z.string(), description: z.string(), weight: z.number().min(0).max(100), guidance: z.string() });
export const ScorecardSchema = z.object({ version: z.number(), criteria: z.array(CriterionSchema).min(1) });
export const TranscriptLineSchema = z.object({ speaker: z.enum(["Agent","Customer"]), text: z.string(), start: z.number(), end: z.number() });
export const CriterionResultSchema = z.object({ criterionId: z.string(), result: z.enum(["pass","partial","fail"]), score: z.number().min(0).max(100), evidenceQuote: z.string(), evidenceStart: z.number() });
export const CallAnalysisSchema = z.object({ language: z.string(), summary: z.string(), wentWell: z.array(z.string()), wentWrong: z.array(z.string()), tags: z.array(z.string()), results: z.array(CriterionResultSchema).min(1) });
export type CallAnalysis = z.infer<typeof CallAnalysisSchema>;
export function weightedScore(results: {criterionId:string;score:number}[], criteria: {id:string;weight:number}[]): number {
  const w = new Map(criteria.map(c=>[c.id,c.weight]));
  let num=0, den=0;
  for (const r of results){ const wt = w.get(r.criterionId) ?? 0; num += r.score*wt; den += wt; }
  if (den===0) return 0;
  return Math.round((num/den)*10)/10;
}
export function verifyEvidenceQuotes(analysis: CallAnalysis, transcript: {text:string}[]): string[] {
  const errors: string[] = [];
  const full = transcript.map(t=>t.text).join("\n");
  const norm = (s:string)=>s.trim().toLowerCase();
  for (const r of analysis.results){
    if (!r.evidenceQuote || !full.toLowerCase().includes(norm(r.evidenceQuote).slice(0,20))) errors.push(`quote not found: ${r.criterionId}`);
  }
  return errors;
}
