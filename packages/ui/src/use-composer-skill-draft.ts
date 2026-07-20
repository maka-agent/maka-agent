import { useEffect, useRef, useState } from 'react';

export interface ComposerSkillSelection {
  id: string;
  name: string;
}

export function addUniqueComposerSkillSelection(
  skills: readonly ComposerSkillSelection[],
  skill: ComposerSkillSelection,
): ComposerSkillSelection[] {
  return skills.some((item) => item.id.toLowerCase() === skill.id.toLowerCase())
    ? [...skills]
    : [...skills, skill];
}

/** Per-session structured Skill selections, parallel to the textarea draft. */
export function useComposerSkillDraft(draftKey: string | undefined) {
  const storeRef = useRef<Map<string, ComposerSkillSelection[]>>(new Map());
  const activeKeyRef = useRef(draftKey);
  const currentRef = useRef<ComposerSkillSelection[]>([]);
  const [skills, setSkillsState] = useState<ComposerSkillSelection[]>([]);

  function commit(next: ComposerSkillSelection[]) {
    currentRef.current = next;
    const key = activeKeyRef.current;
    if (key) storeRef.current.set(key, next);
    setSkillsState(next);
  }

  function add(skill: ComposerSkillSelection) {
    const next = addUniqueComposerSkillSelection(currentRef.current, skill);
    if (next.length === currentRef.current.length) return;
    commit(next);
  }

  function remove(id: string) {
    commit(currentRef.current.filter((item) => item.id !== id));
  }

  function removeLast() {
    if (currentRef.current.length === 0) return false;
    commit(currentRef.current.slice(0, -1));
    return true;
  }

  function clear(key: string | undefined) {
    if (key) storeRef.current.delete(key);
    if (key === activeKeyRef.current) commit([]);
  }

  useEffect(() => {
    const previousKey = activeKeyRef.current;
    if (previousKey === draftKey) return;
    if (previousKey) storeRef.current.set(previousKey, currentRef.current);
    activeKeyRef.current = draftKey;
    const next = draftKey ? [...(storeRef.current.get(draftKey) ?? [])] : [];
    currentRef.current = next;
    setSkillsState(next);
  }, [draftKey]);

  return {
    skills,
    add,
    remove,
    removeLast,
    clear,
    activeDraftKey: () => activeKeyRef.current,
  };
}
