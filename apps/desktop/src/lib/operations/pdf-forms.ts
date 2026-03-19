import { getPdfLib } from '../pdf-engine'
import type { PdfFormField, PdfFormFieldUpdate, PdfFormFieldValue } from '../types'

async function loadDocument(bytes: Uint8Array) {
  const { PDFDocument } = await getPdfLib()
  return PDFDocument.load(bytes.slice(), { updateMetadata: false })
}

async function saveDocument(document: Awaited<ReturnType<typeof loadDocument>>) {
  return document.save()
}

function containsXfaMarker(bytes: Uint8Array) {
  const marker = '/XFA'
  const overlap = marker.length - 1
  const chunkSize = 64 * 1024
  const decoder = new TextDecoder('latin1')

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const start = Math.max(0, offset - overlap)
    const end = Math.min(bytes.length, offset + chunkSize)
    const chunk = decoder.decode(bytes.subarray(start, end))

    if (chunk.includes(marker)) {
      return true
    }
  }

  return false
}

function deriveFieldLabel(name: string) {
  const segments = name.split('.').filter(Boolean)
  return segments.at(-1) ?? name
}

function cloneFormFieldValue(value: PdfFormFieldValue): PdfFormFieldValue {
  return Array.isArray(value) ? [...value] : value
}

function normalizeStringValue(value: PdfFormFieldValue) {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return value[0] ?? ''
  }

  return ''
}

function normalizeStringArrayValue(value: PdfFormFieldValue) {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry.trim().length > 0)
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return [value]
  }

  return []
}

function normalizeTextValue(value: PdfFormFieldValue) {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return value.join(', ')
  }

  if (value === true) {
    return 'true'
  }

  return ''
}

function isEmptyFormValue(value: PdfFormFieldValue) {
  if (Array.isArray(value)) {
    return value.every((entry) => entry.trim().length === 0)
  }

  if (typeof value === 'string') {
    return value.trim().length === 0
  }

  return value !== true
}

function createTextFieldNotes(field: {
  isRichFormatted: () => boolean
  isFileSelector: () => boolean
  isSpellChecked: () => boolean
  isScrollable: () => boolean
}) {
  const notes: string[] = []

  if (field.isRichFormatted()) {
    notes.push('Rich formatting is present. Editing will write a plain-text field value.')
  }

  if (field.isFileSelector()) {
    notes.push('File selector semantics are present. Sampadan edits the stored value as plain text.')
  }

  if (!field.isSpellChecked()) {
    notes.push('Spell checking is disabled by the source form.')
  }

  if (!field.isScrollable()) {
    notes.push('Scrolling is disabled for this field. Long values may clip in some viewers.')
  }

  return notes
}

function createChoiceFieldNotes(options: {
  isEditable?: () => boolean
  isSorted: () => boolean
  isSelectOnClick: () => boolean
  isSpellChecked?: () => boolean
}) {
  const notes: string[] = []

  if (options.isEditable?.()) {
    notes.push('Field allows typed values beyond the listed options.')
  }

  if (options.isSorted()) {
    notes.push('Options are marked as sorted in the source form.')
  }

  if (options.isSelectOnClick()) {
    notes.push('Selection commits immediately on click in supporting viewers.')
  }

  if (options.isSpellChecked && !options.isSpellChecked()) {
    notes.push('Spell checking is disabled by the source form.')
  }

  return notes
}

function createBaseFieldDescriptor(options: {
  field: {
    getName: () => string
    isReadOnly: () => boolean
    isRequired: () => boolean
    isExported: () => boolean
  }
  kind: PdfFormField['kind']
  value: PdfFormFieldValue
  options?: string[]
  multiline?: boolean
  password?: boolean
  combed?: boolean
  maxLength?: number | null
  multiSelect?: boolean
  editable?: boolean
  acceptsCustomText?: boolean
  notes?: string[]
}) {
  const name = options.field.getName()
  return {
    name,
    label: deriveFieldLabel(name),
    kind: options.kind,
    value: cloneFormFieldValue(options.value),
    options: options.options ? [...options.options] : [],
    readOnly: options.field.isReadOnly(),
    required: options.field.isRequired(),
    exported: options.field.isExported(),
    multiline: options.multiline ?? false,
    password: options.password ?? false,
    combed: options.combed ?? false,
    maxLength: options.maxLength ?? null,
    multiSelect: options.multiSelect ?? false,
    editable: options.editable ?? !options.field.isReadOnly(),
    acceptsCustomText: options.acceptsCustomText ?? false,
    notes: options.notes ? [...options.notes] : [],
  } satisfies PdfFormField
}

export async function readFormFieldsFromDocument(bytes: Uint8Array): Promise<PdfFormField[]> {
  if (containsXfaMarker(bytes)) {
    return []
  }

  const pdfLib = await getPdfLib()
  const { PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, PDFSignature } = pdfLib
  const document = await loadDocument(bytes)
  const form = document.getForm()

  return form.getFields().map((field) => {
    if (field instanceof PDFTextField) {
      const notes = createTextFieldNotes(field)
      let value = ''

      try {
        value = field.getText() ?? ''
      } catch {
        notes.push('Rich text value could not be read. Sampadan will treat this as plain text when saving.')
      }

      return createBaseFieldDescriptor({
        field,
        kind: 'text',
        value,
        multiline: field.isMultiline(),
        password: field.isPassword(),
        combed: field.isCombed(),
        maxLength: field.getMaxLength() ?? null,
        notes,
      })
    }

    if (field instanceof PDFCheckBox) {
      return createBaseFieldDescriptor({
        field,
        kind: 'checkbox',
        value: field.isChecked(),
      })
    }

    if (field instanceof PDFRadioGroup) {
      return createBaseFieldDescriptor({
        field,
        kind: 'radio',
        value: field.getSelected() ?? '',
        options: field.getOptions(),
      })
    }

    if (field instanceof PDFDropdown) {
      const selections = field.getSelected()
      const multiSelect = field.isMultiselect()
      return createBaseFieldDescriptor({
        field,
        kind: 'dropdown',
        value: multiSelect ? selections : selections[0] ?? '',
        options: field.getOptions(),
        multiSelect,
        editable: !field.isReadOnly(),
        acceptsCustomText: field.isEditable(),
        notes: createChoiceFieldNotes({
          isEditable: () => field.isEditable(),
          isSorted: () => field.isSorted(),
          isSelectOnClick: () => field.isSelectOnClick(),
          isSpellChecked: () => field.isSpellChecked(),
        }),
      })
    }

    if (field instanceof PDFOptionList) {
      const selections = field.getSelected()
      const multiSelect = field.isMultiselect()
      return createBaseFieldDescriptor({
        field,
        kind: 'option-list',
        value: multiSelect ? selections : selections[0] ?? '',
        options: field.getOptions(),
        multiSelect,
        notes: createChoiceFieldNotes({
          isSorted: () => field.isSorted(),
          isSelectOnClick: () => field.isSelectOnClick(),
        }),
      })
    }

    if (field instanceof PDFSignature) {
      return createBaseFieldDescriptor({
        field,
        kind: 'signature',
        value: null,
        editable: false,
        notes: ['Digital signature fields are inspect-only in Sampadan right now.'],
      })
    }

    const fieldType = field.constructor?.name ?? 'UnknownField'
    const kind = fieldType === 'PDFButton' ? 'button' : 'unknown'
    return createBaseFieldDescriptor({
      field,
      kind,
      value: null,
      editable: false,
      notes: [`${fieldType} fields are not editable in Sampadan yet.`],
    })
  })
}

export async function applyFormFieldValuesToDocument(
  bytes: Uint8Array,
  updates: PdfFormFieldUpdate[],
  options: {
    flatten?: boolean
  } = {},
) {
  if (containsXfaMarker(bytes)) {
    throw new Error('XFA or hybrid forms are not editable yet. Use the AcroForm fallback conversion first.')
  }

  const pdfLib = await getPdfLib()
  const { PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = pdfLib
  const document = await loadDocument(bytes)
  const form = document.getForm()

  const editableFieldDescriptors = readFormFieldsFromDocument(bytes)
  const descriptorByName = new Map((await editableFieldDescriptors).map((field) => [field.name, field]))

  for (const update of updates) {
    const field = form.getFieldMaybe(update.name)
    if (!field || field.isReadOnly()) {
      continue
    }

    const descriptor = descriptorByName.get(update.name)
    if (descriptor?.required && isEmptyFormValue(update.value)) {
      throw new Error(`Required form field "${descriptor.label}" cannot be empty.`)
    }

    try {
      if (field instanceof PDFTextField) {
        const nextValue = normalizeTextValue(update.value)

        if (descriptor && descriptor.maxLength !== null && nextValue.length > descriptor.maxLength) {
          throw new Error(`"${update.name}" accepts at most ${descriptor.maxLength} characters.`)
        }

        field.setText(nextValue || undefined)
        continue
      }

      if (field instanceof PDFCheckBox) {
        if (update.value === true) {
          field.check()
        } else {
          field.uncheck()
        }
        continue
      }

      if (field instanceof PDFRadioGroup) {
        const value = normalizeStringValue(update.value)
        if (value && !field.getOptions().includes(value)) {
          throw new Error(`Choose a valid option for "${update.name}".`)
        }
        if (value) {
          field.select(value)
        } else {
          field.clear()
        }
        continue
      }

      if (field instanceof PDFDropdown) {
        const selections = normalizeStringArrayValue(update.value)
        if (!field.isEditable()) {
          const invalidSelection = selections.find((selection) => !field.getOptions().includes(selection))
          if (invalidSelection) {
            throw new Error(`"${invalidSelection}" is not one of the available options for "${update.name}".`)
          }
        }
        if (selections.length === 0) {
          field.clear()
        } else {
          field.select(field.isMultiselect() ? selections : selections[0], false)
        }
        continue
      }

      if (field instanceof PDFOptionList) {
        const selections = normalizeStringArrayValue(update.value)
        const invalidSelection = selections.find((selection) => !field.getOptions().includes(selection))
        if (invalidSelection) {
          throw new Error(`"${invalidSelection}" is not one of the available options for "${update.name}".`)
        }
        if (selections.length === 0) {
          field.clear()
        } else {
          field.select(field.isMultiselect() ? selections : selections[0], false)
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to apply form field "${update.name}": ${detail}`)
    }
  }

  form.updateFieldAppearances()

  if (options.flatten) {
    if (form.getFields().length === 0) {
      throw new Error('No standard AcroForm fields are available to flatten.')
    }

    form.flatten()
  }

  return saveDocument(document)
}

export async function flattenFormFieldsInDocument(bytes: Uint8Array) {
  if (containsXfaMarker(bytes)) {
    throw new Error('XFA or hybrid forms are not editable yet. Use the AcroForm fallback conversion first.')
  }

  const document = await loadDocument(bytes)
  const form = document.getForm()

  if (form.getFields().length === 0) {
    throw new Error('No standard AcroForm fields are available to flatten.')
  }

  form.flatten()
  return saveDocument(document)
}

export async function convertXfaToAcroFormFallbackInDocument(bytes: Uint8Array) {
  const hadRawXfa = containsXfaMarker(bytes)

  if (!hadRawXfa) {
    throw new Error('This PDF does not contain an XFA form package.')
  }

  const document = await loadDocument(bytes)
  const form = document.getForm()

  if (form.getFields().length === 0) {
    throw new Error('No standard AcroForm fallback fields were found after removing the XFA package.')
  }

  form.updateFieldAppearances()
  return saveDocument(document)
}
