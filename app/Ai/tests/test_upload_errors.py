"""Checkpoint 8 — what an unreadable upload answers.

Driven through `POST /api/v1/knowledge/ingest-document`, the route Node calls, rather
than by calling the service directly: the claim being pinned is the *status code*, and
that is decided in the route's exception handlers. A unit test on `DocumentService` would
prove the extractor raises and say nothing about whether a malformed PDF reaches the
customer as a 400 or as a 500.

The distinction is not cosmetic. Node records this response's message as the source row's
`errorMessage`, which is what the dashboard shows against a failed document. "Internal
server error" tells the user to retry a file that can never parse; the extractor's own
sentence tells them which file to fix.

No embedding provider and no database are involved — every case here fails during
extraction, before either is reached.
"""

import io

import pytest

BOT_ID = "bot_upload_errors"
SOURCE_ID = "src_upload_errors"

URL = "/api/v1/knowledge/ingest-document"


def _upload(filename: str, content: bytes) -> dict:
    """Keyword arguments for the multipart request the route expects.

    httpx takes the file part and the plain form fields through separate arguments,
    unlike `requests`, which packs both into one mapping — hence the two keys rather
    than a single dict.
    """
    return {
        "files": {"file": (filename, io.BytesIO(content), "application/octet-stream")},
        "data": {"bot_id": BOT_ID, "source_id": SOURCE_ID},
    }


def docx_without_text() -> bytes:
    """A structurally valid `.docx` whose body is empty.

    Built rather than hand-rolled as bytes: the point is a document that parses
    successfully and simply has nothing in it, which is a different failure from a
    corrupt file and must not be reported as one.
    """
    from docx import Document

    buffer = io.BytesIO()
    Document().save(buffer)
    return buffer.getvalue()


class TestUnreadableUploadsAreClientErrors:
    @pytest.mark.asyncio
    async def test_a_malformed_pdf_is_a_400_carrying_the_extraction_error(self, async_client):
        response = await async_client.post(URL, **_upload("broken.pdf", b"this is not a PDF"))

        assert response.status_code == 400
        detail = response.json()["detail"]
        # The extractor's own words, not a generic server fault. The exact text comes from
        # pypdf and varies by version, so only the part this service controls is asserted.
        assert "PDF" in detail
        assert "Internal Server Error" not in detail

    @pytest.mark.asyncio
    async def test_a_docx_with_no_text_is_a_400_saying_so(self, async_client):
        response = await async_client.post(URL, **_upload("empty.docx", docx_without_text()))

        assert response.status_code == 400
        assert "no extractable text" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_an_unsupported_extension_is_a_400_naming_the_accepted_types(self, async_client):
        response = await async_client.post(URL, **_upload("notes.txt", b"plain text"))

        assert response.status_code == 400
        detail = response.json()["detail"]
        assert ".pdf" in detail and ".docx" in detail

    @pytest.mark.asyncio
    async def test_an_empty_file_is_a_400_rather_than_an_empty_document(self, async_client):
        # A zero-byte upload would otherwise reach the extractor and be reported as
        # "contains no extractable text" — true, but it describes the wrong problem.
        response = await async_client.post(URL, **_upload("blank.pdf", b""))

        assert response.status_code == 400
        assert "empty" in response.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_no_file_part_at_all_is_rejected(self, async_client):
        response = await async_client.post(
            URL,
            data={"bot_id": BOT_ID, "source_id": SOURCE_ID},
        )

        # FastAPI's own validation for a required multipart field: the request never
        # reaches the handler, so nothing is extracted and no vector is written.
        assert response.status_code == 422
