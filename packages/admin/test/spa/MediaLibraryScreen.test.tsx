// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaLibraryScreen } from "../../spa/screens/MediaLibraryScreen";

const listMock = vi.fn();
const deleteMock = vi.fn();
const uploadMock = vi.fn();
const urlMock = vi.fn((key: string) => `/files/${key}`);

vi.mock("../../spa/api", () => ({
  client: {
    entity: () => ({
      list: (...args: unknown[]) => listMock(...args),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: (...args: unknown[]) => deleteMock(...args),
    }),
    media: {
      upload: (...args: unknown[]) => uploadMock(...args),
      url: (key: string) => urlMock(key),
    },
  },
}));

const IMAGE = {
  id: "m1",
  key: "abc.png",
  filename: "photo.png",
  contentType: "image/png",
  size: 1024,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const DOC = {
  id: "m2",
  key: "def.pdf",
  filename: "doc.pdf",
  contentType: "application/pdf",
  size: 2048,
  createdAt: "2026-01-02T00:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
  listMock.mockReset();
  deleteMock.mockReset();
  uploadMock.mockReset();
});

describe("MediaLibraryScreen", () => {
  it("lists items, rendering an <img> for an image contentType with src = client.media.url(key)", async () => {
    listMock.mockResolvedValueOnce({ data: [IMAGE, DOC], meta: { total: 2, limit: 100, offset: 0 } });
    render(<MediaLibraryScreen />);

    const img = (await screen.findByAltText("photo.png")) as HTMLImageElement;
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toBe("/files/abc.png");
    expect(screen.getByText("doc.pdf")).toBeInTheDocument();
    expect(screen.queryByAltText("doc.pdf")).not.toBeInTheDocument();
  });

  it("uploading a file calls client.media.upload and refreshes the list", async () => {
    listMock.mockResolvedValue({ data: [], meta: { total: 0, limit: 100, offset: 0 } });
    uploadMock.mockResolvedValueOnce({ key: "new.png", filename: "new.png", contentType: "image/png", size: 10 });
    render(<MediaLibraryScreen />);
    await screen.findByText("No media files.");

    const file = new File(["x"], "new.png", { type: "image/png" });
    const input = screen.getByLabelText(/upload file/i);
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(uploadMock).toHaveBeenCalledWith(file));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it("deletes a file after confirm via client.entity('media_files').delete", async () => {
    listMock.mockResolvedValueOnce({ data: [IMAGE], meta: { total: 1, limit: 100, offset: 0 } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    deleteMock.mockResolvedValueOnce(undefined);
    listMock.mockResolvedValueOnce({ data: [], meta: { total: 0, limit: 100, offset: 0 } });

    render(<MediaLibraryScreen />);
    await screen.findByAltText("photo.png");

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("m1"));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it("does not delete when confirm is dismissed", async () => {
    listMock.mockResolvedValueOnce({ data: [IMAGE], meta: { total: 1, limit: 100, offset: 0 } });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<MediaLibraryScreen />);
    await screen.findByAltText("photo.png");

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
