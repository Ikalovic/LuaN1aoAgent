import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StructuredReport } from "./StructuredReport";

describe("StructuredReport", () => {
  it("renders parsed report sections and preserves raw text", () => {
    const text = "== RESULT ==\nStatus: completed\n- evidence saved";
    render(<StructuredReport text={text} />);
    expect(screen.getByRole("heading", { name: "RESULT" })).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
    fireEvent.click(screen.getByText("原始文本"));
    expect(document.querySelector(".structured-report-raw")?.textContent).toBe(text);
  });
});
