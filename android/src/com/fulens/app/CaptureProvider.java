package com.fulens.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

/** Exposes only the temporary camera image, with per-intent URI grants. */
public final class CaptureProvider extends ContentProvider {
    public static Uri uriFor(Context context) {
        return Uri.parse("content://" + context.getPackageName() + ".capture/capture.jpg");
    }

    private File image(Uri uri) throws FileNotFoundException {
        if (!uriFor(getContext()).equals(uri)) throw new FileNotFoundException("Unknown image");
        return new File(getContext().getCacheDir(), "capture.jpg");
    }

    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { return "image/jpeg"; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        return ParcelFileDescriptor.open(image(uri), ParcelFileDescriptor.parseMode(mode));
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection,
                                  String[] args, String order) {
        try {
            File file = image(uri);
            String[] columns = projection == null
                ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
            MatrixCursor cursor = new MatrixCursor(columns, 1);
            MatrixCursor.RowBuilder row = cursor.newRow();
            for (String column : columns) {
                row.add(OpenableColumns.DISPLAY_NAME.equals(column) ? file.getName()
                    : OpenableColumns.SIZE.equals(column) ? file.length() : null);
            }
            return cursor;
        } catch (FileNotFoundException error) { return null; }
    }

    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { return 0; }
    @Override public int delete(Uri uri, String selection, String[] args) { return 0; }
}
