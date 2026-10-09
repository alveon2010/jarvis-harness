import { describe, expect, it } from "vitest";
import { describeFrame, type FigmaDesign } from "../../src/design/figma.ts";
import { frameNamesOf, humanizeNodeIds, humanizeSource } from "../../src/design/frames.ts";
import { questionsOf, questionText } from "../../src/interaction/questions.ts";

/** A canvas of two sections, each a screen: the target and the current one. */
const CANVAS: FigmaDesign = {
  name: "Checkout '26",
  nodes: [
    {
      id: "100:1",
      name: "Delivery slots",
      type: "CANVAS",
      children: [
        {
          id: "100:2",
          name: "To be - courier",
          type: "SECTION",
          children: [
            {
              id: "100:3",
              name: "1440 desktop",
              type: "FRAME",
              children: [{ id: "100:4", type: "TEXT", text: "Pick a delivery slot" }],
            },
          ],
        },
        {
          id: "100:5",
          name: "AS IS",
          type: "SECTION",
          children: [
            { id: "100:7", type: "TEXT", text: "Old flow, for reference" },
            {
              id: "100:6",
              name: "1440 desktop",
              type: "FRAME",
              children: [{ id: "100:8", type: "TEXT", text: "Choose your delivery type" }],
            },
          ],
        },
      ],
    },
  ],
};

describe("design frames by screen (pilot: «which variant of frame 100:1 is the target»)", () => {
  it("a canvas of sections: each screen's texts under its section's name", () => {
    const t = describeFrame(CANVAS).text;
    expect(t).toContain("Screens (3), each with its texts below:");
    expect(t).toContain("#### To be - courier › 1440 desktop · node 100:3\n- «Pick a delivery slot»");
    expect(t).toContain("#### AS IS › 1440 desktop · node 100:6\n- «Choose your delivery type»");
    expect(t).toContain("#### AS IS\n- «Old flow, for reference»");
    expect(t).not.toContain("Texts, in order:");
    // one screen: as before
    const single = describeFrame({
      name: "x",
      nodes: [CANVAS.nodes[0]?.children?.[0]?.children?.[0] as never],
    });
    expect(single.text).toContain("Texts, in order:\n- «Pick a delivery slot»");
  });

  it("node ids become the names a person knows, with the frame's link; questions read as lines", () => {
    const design = [
      "# Design frames of the task",
      "## 1. Delivery slots",
      "From the issue · https://www.figma.com/design/K/x?node-id=100-1",
      "",
      "Figma: Checkout '26 · node 100:1 · https://www.figma.com/design/K/x?node-id=100-1&t=a",
      "#### To be - courier › 1440 desktop · node 100:3",
    ].join("\n");
    const names = frameNamesOf(design);
    expect(names.get("100:1")).toEqual({
      name: "Delivery slots",
      link: "https://www.figma.com/design/K/x?node-id=100-1&t=a",
    });
    expect(names.get("100:3")?.link).toBe("https://www.figma.com/design/K/x?node-id=100-3&t=a");
    expect(humanizeNodeIds("Which variant of frame 100:1 is the target? (node-id=100-1, 10:30)", names)).toBe(
      "Which variant of frame «Delivery slots» is the target? (node-id=100-1, 10:30)",
    );
    expect(humanizeSource("frame 100:3", names)).toEqual({
      text: "frame «To be - courier › 1440 desktop»",
      link: "https://www.figma.com/design/K/x?node-id=100-3&t=a",
    });
    expect(humanizeSource("ABC-42", names)).toEqual({ text: "ABC-42" });
    expect(
      questionText(
        {
          question: "Is the slot required?",
          about: "screen «To be - courier»",
          options: ["yes", "no"],
          refs: ["100:3"],
        },
        names,
      ),
    ).toBe("Is the slot required? (screen «To be - courier») — yes / no");
    expect(questionsOf(["Plain one?", { question: "" }, 3, { question: "In 100:1?" }], names)).toEqual([
      "Plain one?",
      "In «Delivery slots»?",
    ]);
  });
});
