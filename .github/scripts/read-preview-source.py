"""Read one small JSON record without extracting or executing an artifact."""
import io
import sys
import zipfile

data = sys.stdin.buffer.read(1024 * 1024 + 1)
if len(data) > 1024 * 1024:
    raise ValueError('Preview source archive is too large')
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    if archive.namelist() != ['preview-source.json']:
        raise ValueError('Unexpected preview source archive contents')
    if archive.getinfo('preview-source.json').file_size > 4096:
        raise ValueError('Preview source record is too large')
    sys.stdout.buffer.write(archive.read('preview-source.json'))
