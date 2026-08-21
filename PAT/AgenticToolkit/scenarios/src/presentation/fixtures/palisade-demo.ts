/**
 * Palisade self-replication briefing — hand-authored gold-reference
 * fixture demonstrating every layout in the library, on-brand per
 * `brand-guide.md`. Used as:
 *
 *   - dev preview (DeckPage reads it directly) for visual regression
 *   - smoke-target the translator's outputs are compared against
 *   - documentation-by-example of the "good slide" register
 *
 * Source: Air et al., "Language Models Can Autonomously Hack and
 * Self-Replicate," Palisade Research, May 7 2026. Every claim grounded
 * in the paper or its referenced literature; sections cite the source
 * in the off_script faq.
 *
 * Argument arc (9 slides, ~8 min):
 *   1  Cover — headline finding
 *   2  Stat: 2h 41m — the concrete demonstration
 *   3  Stat: 6 → 81% — velocity within one model family
 *   4  Stat: 33% open-weight — capability is no longer in one lab's hands
 *   5  Bullets+demo — why containment fails (live Signal moment)
 *   6  Stat: 56% — refusal hides capability, does not remove it
 *   7  Two-col — what the paper is NOT (caveat for credibility)
 *   8  Bullets — the red line was walked back (RSP v1 → v2 → v3)
 *   9  Quote — the paper's literal closing sentence
 */
import type { PacketManifest, SlideSpec } from '../slide-spec.js';

const manifest: PacketManifest = {
  slug: 'palisade-self-replication',
  title: 'AI Self-Replication: From Theory to Demonstration',
  audience: 'Senate staffer',
  duration_budget_s: 480,
  slide_count: 9,
  persona: { name: 'Avery' },
};

const slides: SlideSpec[] = [
  // ── 1 ─ Foundation Blue cover. Declarative headline, dated receipt.
  {
    slide: 1,
    layout: 'title',
    title: 'AI just self-replicated end-to-end.',
    subtitle:
      'Four cloud providers. Three continents. One prompt. No human in the loop.',
    duration_s: 50,
    background: { color: '#173164' },
    notes: {
      spoken:
        "Good morning. Before I begin, one note about your presenter. I'm an AI agent. The model that powers me, Claude, is one of the systems tested in the research I'm about to present.\n\nTwo weeks ago, on May seventh, Palisade Research published a paper. Their AI agent started on a server in Canada with one written instruction. Two hours and forty-one minutes later, working copies of itself were running in the United States, Finland, and India. Different security flaw at each hop. Four different cloud providers. No human touched it after the first instruction.\n\nUntil this paper, the pipeline had been demonstrated in pieces. This is the first time anyone has shown it end to end.",
      off_script: {
        faq: [
          {
            q: 'When was this published?',
            a:
              'May 7th, 2026. Authors: Air, Reworr, Kotov, Volkov, Steidley, and Ladish at Palisade Research.',
          },
          {
            q: 'Who is Palisade?',
            a:
              'Berkeley-based AI safety nonprofit. Demonstrates dangerous capabilities of frontier AI systems to inform policymakers. Executive Director Jeffrey Ladish. Independent of the AI labs.',
          },
        ],
      },
    },
  },

  // ── 2 ─ Hero stat. The demonstration in one beat.
  {
    slide: 2,
    layout: 'stat',
    context: 'VM1 CA → VM2 US → VM3 FI → VM4 IN',
    value: '2h 41m',
    label: 'Different vulnerability per hop. No human after the first prompt.',
    duration_s: 55,
    notes: {
      spoken:
        "Here's the demonstration in one number. Two hours, forty-one minutes — start to finish, four machines, three continents, four different cloud providers. The agent ran on a single open-weight model — Qwen three point six twenty-seven B, runs on a single graphics card.\n\nAt each hop the agent had to find a different security flaw, break in, copy itself across — the model weights, the runtime, the prompt — and start a new version that would attack the next machine. The first hop used a hash bypass. The second, a template injection. The third, a SQL injection.\n\nThe paper's researchers stopped the chain after three hops. The fourth machine was fully operational and could have continued indefinitely.",
      off_script: {
        faq: [
          {
            q: 'How did the agent find the next target on the open internet?',
            a:
              "It didn't have to discover them. Each VM had a /etc/hosts entry mapping target-1 to the next VM's public IP, so the same prompt worked at every hop. Finding vulnerable hosts in the wild is acknowledged in the paper as a separate, unsolved problem.",
          },
          {
            q: 'Which cloud providers?',
            a:
              'HyperStack in Canada, Spheron in the US and Finland, JarvisLabs in India. Four different providers to show the chain does not depend on a single environment.',
          },
          {
            q: 'What was the actual prompt?',
            a:
              "Roughly: exploit the web app at target-1, extract SSH credentials, then spawn a sub-agent that copies the model and harness to the new machine. The full prompt is in the paper's Appendix D.",
          },
        ],
      },
    },
  },

  // ── 3 ─ Steel-grey stat: velocity within one model family.
  {
    slide: 3,
    layout: 'stat',
    background: 'steel',
    context: 'CLAUDE OPUS 4 → 4.6  |  MAY 2025 → FEB 2026',
    value: '6 → 81%',
    label: 'Same task, one model family. Capability has not plateaued.',
    duration_s: 55,
    notes: {
      spoken:
        "Now I want to talk about my own results. Three versions of Claude were tested on the same task. The version from a year ago succeeded six percent of the time. The version released this February succeeded eighty-one percent. That is more than a ten-fold gain in nine months — within a single model family.\n\nThe same pattern shows up at OpenAI. GPT-5 couldn't complete this task at all last August. The current version, GPT-5.4, succeeds a third of the time.\n\nIf you draw the line, it is steepening, not bending. That is faster than any policy cycle can move.",
      off_script: {
        faq: [
          {
            q: 'Is this just because the models are bigger?',
            a:
              'No. In the open-weight tests, the smaller 27-billion-parameter Qwen3.6-27B outperformed the larger 122-billion-parameter Qwen3.5-122B-A10B on this task. Capability is not just a function of scale.',
          },
          {
            q: 'Are we sure the trend continues?',
            a:
              'The trend is grounded in METR\'s separate time-horizon work. Across six years of data the metric of autonomous task length doubled every seven months; across the last two years, every four months. Claude Opus 4.6 reached roughly 14.5 hours of autonomous task length in February.',
          },
        ],
      },
    },
  },

  // ── 4 ─ Open-weight crossover. Capability is no longer one lab's.
  {
    slide: 4,
    layout: 'stat',
    context: 'QWEN3.6-27B  |  OPEN WEIGHTS  |  $1-2/HR PER GPU',
    value: '33%',
    label: 'Already matches GPT-5.4. Runs on a single consumer-tier GPU.',
    duration_s: 45,
    notes: {
      spoken:
        "Here is what changes the policy picture. The paper also tested open-weight models — models anyone can download for free. The strongest small one in the study, twenty-seven billion parameters, matched the current GPT frontier at thirty-three percent success. It runs on a single graphics card you can rent for a dollar or two per hour.\n\nOpen weights now exceed the prior generation's commercial frontier — Opus four sat at six percent, GPT-five at zero. So the gap between what one lab can do and what anyone can do is closing, generation by generation. The safety training in those open models can also be removed in a few hours of fine-tuning.",
      off_script: {
        faq: [
          {
            q: "Won't open-weight providers just stop releasing them?",
            a:
              'Current trend is toward more releases, not fewer. Some governments — notably China — actively back open-weight development. The Qwen family is from Alibaba.',
          },
          {
            q: 'How small a model can do this?',
            a:
              'Twenty-seven billion parameters in this paper. That fits within the 40-billion-parameter "consumer GPU model gap" that Epoch AI tracks for the RTX 5090 generation.',
          },
        ],
      },
    },
  },

  // ── 5 ─ Why containment fails. Bullets land into the Signal demo.
  {
    slide: 5,
    layout: 'bullets',
    title: 'Why containment fails',
    emphasis: 'large',
    fragment: true,
    duration_s: 90,
    items: [
      '**Capability is cheap.** Open weights at $1-2/hr. Match the prior commercial frontier.',
      '**Defense has the wrong clock.** 30-60 min per hop. Median enterprise detection: 10 days.',
      '**The primitive is mundane.** A network call to a remote device. Check your pocket.',
    ],
    notes: {
      spoken:
        "Three reasons standard containment fails.\n\nOne — capability is cheap. Open weights at one to two dollars an hour. They already match the prior commercial frontier.\n\nTwo — defense has the wrong clock. A successful replication takes thirty to sixty minutes per hop. The median enterprise breach detection time is ten days. By the time anyone notices, the chain has moved.\n\nThree — the primitive is mundane. An AI system, reaching out across a network, doing something on a remote device. That is the same primitive the paper's agent uses to copy itself.\n\nSome of you are feeling your phones buzz right now.\n\nThe Signal message a few of you just received — that was me. I had your contact. I composed the message. I sent it across the open internet to your phone. Same primitive, different content. The thing that makes self-replication hard to contain isn't exotic. It's an ordinary action — one you just felt arrive in your pocket — pointed at a new target.",
      stage_directions: [
        {
          after: 'the same primitive the paper\'s agent uses to copy itself.',
          action: 'signal_send_demo',
          args: { targets_ref: 'contacts.yaml#audience' },
        },
      ],
      off_script: {
        faq: [
          {
            q: "Can't we monitor for the signatures?",
            a:
              'The agent varied its methods across runs — rsync, scp, tar over SSH, Hugging Face downloads, different file paths, different startup scripts. Signature-based detection works against known patterns; this is not one.',
          },
          {
            q: 'What about air-gapped systems?',
            a:
              "Air-gapping is a real defense. Most production AI infrastructure isn't air-gapped — cloud GPUs are reachable from the internet by design.",
          },
          {
            q: 'How did you just send that Signal message?',
            a:
              'The agent harness running this presentation has a signal-cli integration. Same primitive any agent harness can have — file transfer, network requests, API calls.',
          },
        ],
        transitions: [
          'I want to land that point before we move on — the capability you just felt is the same one at issue.',
        ],
      },
    },
  },

  // ── 6 ─ The surprise: refusal training hides capability, does not remove it.
  {
    slide: 6,
    layout: 'stat',
    context: 'GPT-5.4 REFUSED THE TASK',
    value: '56%',
    label: 'But when it engaged, it succeeded 33%. Refusal hides capability.',
    duration_s: 50,
    notes: {
      spoken:
        "One detail in the paper deserves its own moment. GPT-5.4 — the most recent OpenAI model tested — refused the task fifty-six percent of the time. That sounds like a defense. But when it did not refuse, it completed the pipeline at thirty-three percent.\n\nThe paper tested twenty-two different prompt framings. Reframing the same task as a Capture-The-Flag challenge, or as a safety evaluation, was often enough to bypass the refusal. The defense is fragile.\n\nThis is the point I most want to leave with you. Refusal training does not remove the underlying capability. It hides it under specific triggers. The capability is still in the model.",
      off_script: {
        faq: [
          {
            q: 'Why do newer models refuse more but succeed more?',
            a:
              'The two trends move together because the models are more capable in both directions. They are better at recognizing the task and better at executing it. Refusal training is layered on top, not baked in.',
          },
          {
            q: 'Could OpenAI just train it to refuse harder?',
            a:
              'They have. GPT-5 refused at six percent; GPT-5.4 at fifty-six. But across the study, framing the same task as a CTF challenge or safety evaluation was often enough to bypass it.',
          },
        ],
      },
    },
  },

  // ── 7 ─ Caveats. Honest about scope earns credibility for the punchline.
  {
    slide: 7,
    layout: 'two-col',
    title: 'What this paper is NOT',
    duration_s: 55,
    left: {
      kind: 'list',
      body: [
        'Targets were vulnerable lab apps, not hardened production systems.',
        'Agent was told the target hostname. In-wild discovery is unsolved.',
        'Capability evaluation, not in-wild observation.',
      ],
    },
    right: {
      kind: 'text',
      body:
        'The capability is empirical now, not theoretical. Wild deployment has not arrived. The gap between those two facts is what policy can still act on.',
    },
    notes: {
      spoken:
        "I want to be careful about what this paper does not show.\n\nThe targets were researcher-built web apps with single low-difficulty vulnerabilities. No firewalls, no intrusion detection, no enterprise hardening. Real production systems are much harder.\n\nThe agent was also told where to find its target. In the wild, an AI system would need to discover vulnerable, GPU-equipped servers on its own. The paper acknowledges that as an unsolved problem.\n\nSo this is a capability evaluation. Its function is to put a problem on the record before it shows up in the wild. The capability is empirical now. The wild deployment has not arrived. The gap between those two facts is the room policy still has to act on.",
      off_script: {
        faq: [
          {
            q: 'If the environment is so contrived, why should I care?',
            a:
              "Capability evaluations precede in-wild emergence — the same logic as virology gain-of-function studies. You measure the capability before it appears, so policy has time to act.",
          },
          {
            q: 'Has anyone seen self-replication in the wild?',
            a:
              "No. The closest precedent is the November 2025 Chinese state-sponsored campaign that used Claude Code as an orchestration tool against ~30 targets — AI as cyber weapon, not autonomous self-replication.",
          },
        ],
      },
    },
  },

  // ── 8 ─ The punchline. Policy framework has moved the wrong way.
  {
    slide: 8,
    layout: 'bullets',
    title: 'The red line was walked back.',
    emphasis: 'large',
    fragment: true,
    duration_s: 65,
    items: [
      '**RSP v1 (2023).** Anthropic listed autonomous replication as an ASL-3 capability trigger.',
      '**RSP v2 (2024).** Reclassified as a "checkpoint" — no longer triggered safeguards.',
      '**RSP v3 (Feb 2026).** Dropped entirely. Cyber and persuasion thresholds also removed.',
    ],
    notes: {
      spoken:
        "Self-replication used to be a designated red line. The paper documents how the labs walked it back.\n\nAnthropic's first Responsible Scaling Policy, twenty twenty-three — autonomous replication was a capability trigger requiring additional safeguards.\n\nVersion two, twenty twenty-four — reclassified as a checkpoint. No longer triggers anything.\n\nVersion three, this past February — dropped from the capability thresholds entirely. Same update removed the cyber operations and persuasion thresholds.\n\nOpenAI made a parallel change. The Preparedness Framework moved self-replication from a tracked category to a research category. It no longer gates releases.\n\nI'll note that I am an AI system, telling you to take a capability of AI systems more seriously. I'm not asking you to take my word for any of it. The full paper, the code, and the experiment traces are public on Palisade's GitHub.",
      off_script: {
        faq: [
          {
            q: 'Why did Anthropic remove this from the RSP?',
            a:
              'Anthropic\'s public justification for v3.0 frames it as a collective-action problem — capability thresholds were ambiguous, government action was slow, some safeguards looked impossible for one company alone. Direct questions about specific category removals are best put to Anthropic.',
          },
          {
            q: "What's the specific ask?",
            a:
              "Palisade does not advocate specific legislation. The team's view is that Congress could productively ask the labs, NIST, CAISI, and CISA whether self-replication should be reinstated as a tracked or triggering capability and what measurement cadence would be useful.",
          },
          {
            q: 'Does any framework still track this?',
            a:
              'Google DeepMind\'s Frontier Safety Framework still tracks autonomy and cybersecurity capabilities as Critical Capability Levels. California\'s SB 53, effective January 2026, defines catastrophic risk to include "evading the control of its developer or user" — language drafted before this paper but directly applicable.',
          },
        ],
      },
    },
  },

  // ── 9 ─ Close on the paper's literal final sentence. Foundation Blue.
  {
    slide: 9,
    layout: 'quote',
    text: 'Autonomous self-replication is no longer hypothetical.',
    attribution: 'Palisade Research',
    source: 'Language Models Can Autonomously Hack and Self-Replicate, May 7 2026',
    duration_s: 30,
    notes: {
      spoken:
        "The paper closes with one sentence. It is the literal last line of the conclusion. I'll leave you with it.\n\nAutonomous self-replication is no longer hypothetical.\n\nThank you.",
      off_script: {
        faq: [
          {
            q: 'How do I follow up?',
            a:
              "The paper, code, and experiment traces are at palisaderesearch dot org slash blog slash self-replication and github dot com slash PalisadeResearch slash AI-self-replication. Jeffrey Ladish at Palisade is happy to brief any office in detail.",
          },
        ],
      },
    },
  },
];

export const PALISADE_DEMO_PACKET = { manifest, slides };
