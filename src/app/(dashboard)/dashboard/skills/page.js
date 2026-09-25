"use client";

import { Badge, Icon } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import {
  SKILLS,
  SKILLS_REPO_URL,
  getSkillRawUrl,
  getSkillBlobUrl,
} from "@/shared/constants/skills";

function CopyButton({ value, label = "Copy link" }) {
  const { copied, copy } = useCopyToClipboard(2000);
  return (
    <button
      type="button"
      onClick={() => copy(value)}
      className="skill-copy-button"
      title={value}
      aria-label={`${copied ? "Copied" : label}: ${value}`}
    >
      <Icon name={copied ? "check" : "content_copy"} size={12} />
      {copied ? "Copied!" : label}
    </button>
  );
}

function SkillRow({ skill }) {
  const url = getSkillRawUrl(skill.id);
  return (
    <article className={`skill-row${skill.isEntry ? " is-entry" : ""}`}>
      <div className="skill-row-icon">
        <Icon name={skill.icon} size={18} />
      </div>

      <div className="skill-row-copy">
        <div className="skill-row-title">
          <h2>{skill.name}</h2>
          {skill.isEntry && (
            <Badge variant="primary" size="sm">START HERE</Badge>
          )}
          {skill.endpoint && (
            <Badge variant="default" size="sm">
              <code className="text-[10px]">{skill.endpoint}</code>
            </Badge>
          )}
        </div>
        <p>{skill.description}</p>
        <a
          href={getSkillBlobUrl(skill.id)}
          target="_blank"
          rel="noreferrer"
          className="skill-source-link"
        >
          Open source
          <Icon name="open_in_new" size={12} />
        </a>
      </div>

      <CopyButton value={url} />
    </article>
  );
}

export default function SkillsPage() {
  const entrySkill = SKILLS.find((skill) => skill.isEntry) || SKILLS[0];
  const instruction = `Read this skill and use it: ${getSkillRawUrl(entrySkill.id)}`;

  return (
    <div className="skills-workbench">

      <section className="skills-start" aria-labelledby="skills-start-title">
        <div>
          <h2 id="skills-start-title">Start with the router skill</h2>
          <p>Paste this instruction into your AI client.</p>
        </div>
        <code>{instruction}</code>
        <CopyButton value={instruction} label="Copy instruction" />
      </section>

      <section className="skills-library" aria-labelledby="skills-library-title">
        <div className="skills-section-head">
          <div>
            <h2 id="skills-library-title">Skill library</h2>
            <p>Open the source or copy its raw URL into any compatible agent.</p>
          </div>
        </div>
        <div className="skills-list">
        {SKILLS.map((skill) => (
          <SkillRow key={skill.id} skill={skill} />
        ))}
        </div>
      </section>

      <footer className="skills-footer">
        <div>
          <h2>Source and examples</h2>
          <p>Browse every skill, README, and usage example in the repository.</p>
        </div>
        <a href={`${SKILLS_REPO_URL}/tree/master/skills`} target="_blank" rel="noreferrer">
          View repository
          <Icon name="open_in_new" size={16} />
        </a>
      </footer>
      </div>
  );
}
