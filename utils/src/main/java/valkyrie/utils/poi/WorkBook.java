package valkyrie.utils.poi;

/* -------------------------------------------------------------------------------- *\
|*                                                                                  *|
|*    Copyright (C) 2019-2024 Luo Tiansheng All rights reserved.                    *|
|*                                                                                  *|
|*    Licensed under the Apache License, Version 2.0 (the "License");               *|
|*    you may not use this file except in compliance with the License.              *|
|*    You may obtain a copy of the License at                                       *|
|*                                                                                  *|
|*        http://www.apache.org/licenses/LICENSE-2.0                                *|
|*                                                                                  *|
|*    Unless required by applicable law or agreed to in writing, software           *|
|*    distributed under the License is distributed on an "AS IS" BASIS,             *|
|*    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.      *|
|*    See the License for the specific language governing permissions and           *|
|*    limitations under the License.                                                *|
|*                                                                                  *|
\* -------------------------------------------------------------------------------- */

import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import valkyrie.utils.Captor;
import valkyrie.utils.Optional;
import valkyrie.utils.TypeConverter;
import valkyrie.utils.annotations.RowColumn;
import valkyrie.utils.collection.Lists;
import valkyrie.utils.collection.Maps;
import valkyrie.utils.io.UFile;
import valkyrie.utils.reflect.UClass;
import valkyrie.utils.reflect.UField;
import valkyrie.utils.stream.Streams;
import valkyrie.utils.string.StrStaticImports;
import valkyrie.utils.time.DateFormatter;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.util.Date;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

import static valkyrie.utils.TypeConverter.atos;

/**
 * 类 {@link WorkBook} 用于创建和操作 Excel 工作簿。
 *
 * <p>该类使用 Apache POI 库来实现工作簿的创建和行的添加。
 * 默认情况下，会创建一个名为 "Sheet1" 的工作表。
 *
 * <p>可以通过 {@link #addRow(Object...)} 方法添加行数据，
 * 通过 {@link #getRow(int)} 方法获取指定行的数据。
 *
 * <p>调用 {@link #write(OutputStream)} 方法可以将工作簿写入指定的输出流。
 *
 * <p>注意：在使用此类时，请确保已添加 Apache POI 依赖。
 *
 * @author Luo Tiansheng
 */
public class WorkBook implements Iterable<Row> {

    /**
     * Apache POI 工作簿实例，用于创建和操作 Excel 文件。
     */
    private final Workbook wb;

    /**
     * 当前工作簿中的工作表。
     */
    private Sheet sheet;

    /**
     * 将Cell中不同类型的数据转格式化为文本
     */
    private final DataCellFormatter cellFormatter = new DataCellFormatter();

    /**
     * #brief: 创建一个空的 Workbook 实例
     *
     * <p>使用默认的 XSSFWorkbook 创建一个新的 Workbook
     * 对象。
     */
    private WorkBook() {
        this(new XSSFWorkbook());
    }

    /**
     * #brief: 根据指定路径创建 Workbook 实例
     *
     * <p>根据提供的文件路径，创建一个新的 Workbook
     * 实例。如果文件不存在或格式不正确，可能会抛出
     * 异常。
     *
     * @param pathname Excel 文件的路径
     */
    private WorkBook(String pathname) {
        this(new UFile(pathname));
    }

    /**
     * #brief: 根据指定文件创建 Workbook 实例
     *
     * <p>根据提供的 File 对象，创建一个新的 Workbook
     * 实例。如果文件不存在或格式不正确，可能会抛出
     * 异常。
     *
     * @param mutableFile Excel 文件对象
     */
    private WorkBook(UFile mutableFile) {
        this(Captor.call(() -> new XSSFWorkbook(mutableFile)));
    }

    /**
     * #brief: 根据输入流创建 Workbook 实例
     *
     * <p>根据提供的输入流，创建一个新的 Workbook
     * 实例。输入流需指向有效的 Excel 文件内容。
     * 如果输入流无效，可能会抛出异常。
     *
     * @param stream 输入流，需指向有效的 Excel 文件内容
     */
    private WorkBook(InputStream stream) {
        this(Captor.call(() -> new XSSFWorkbook(stream)));
    }

    /**
     * #brief: 使用现有的 XSSFWorkbook 创建 Workbook 实例
     *
     * <p>接受一个已存在的 XSSFWorkbook 对象并将其
     * 包装为新的 Workbook 实例。
     *
     * @param workbook 已存在的 XSSFWorkbook 对象
     */
    private WorkBook(XSSFWorkbook workbook) {
        this.wb = workbook;
        /* switch sheet. */
        if (wb.getNumberOfSheets() > 0)
            this.sheet = wb.getSheet(wb.getSheetName(0));
    }

    /**
     * #brief: 创建包含默认工作表的工作簿
     *
     * <p>创建一个新的工作簿，并默认包含三个工作表（Sheet0, Sheet1, Sheet2）。
     * 适用于需要快速初始化工作簿的场景。
     *
     * @return 包含默认工作表的工作簿
     */
    public static WorkBook create() {
        return ofSheet("Sheet0", "Sheet1", "Sheet2");
    }

    /**
     * #brief: 创建包含单个工作表的工作簿
     *
     * <p>创建一个新的工作簿，并包含一个指定名称的工作表。
     * 适用于需要自定义工作表名称的场景。
     *
     * @param sheetName 工作表名称
     * @return 包含指定工作表的工作簿
     */
    public static WorkBook ofSheet(String sheetName) {
        return ofSheet(new String[]{sheetName});
    }

    /**
     * #brief: 创建包含多个工作表的工作簿
     *
     * <p>创建一个新的工作簿，并包含多个指定名称的工作表。
     * 第一个工作表会被设置为当前活动工作表。
     *
     * @param sheets 工作表名称数组
     * @return 包含多个工作表的工作簿
     */
    public static WorkBook ofSheet(String ...sheets) {
        WorkBook workbook = new WorkBook();
        for (String sheet : sheets)
            workbook.createSheet(sheet);
        workbook.checkout(sheets[0]); /* 默认使用第一个 Sheet */
        return workbook;
    }

    /**
     * #brief: 根据文件路径加载 Workbook 实例
     *
     * <p>根据提供的文件路径，加载并返回对应的
     * Workbook 实例。如果文件不存在或格式不正确，可能
     * 会抛出异常。
     *
     * @param pathname Excel 文件的路径
     * @return 加载的 Workbook 实例
     */
    public static WorkBook load(String pathname) {
        return load(new UFile(pathname));
    }

    /**
     * #brief: 根据 File 对象加载 Workbook 实例
     *
     * <p>根据提供的 File 对象，加载并返回对应的
     * Workbook 实例。如果文件不存在或格式不正确，可能
     * 会抛出异常。
     *
     * @param mutableFile Excel 文件对象
     * @return 加载的 Workbook 实例
     */
    public static WorkBook load(UFile mutableFile) {
        return new WorkBook(mutableFile);
    }

    /**
     * #brief: 根据输入流加载 Workbook 实例
     *
     * <p>根据提供的输入流，加载并返回对应的
     * Workbook 实例。输入流需指向有效的 Excel 文件内容。
     * 如果输入流无效，可能会抛出异常。
     *
     * @param stream 输入流，需指向有效的 Excel 文件内容
     * @return 加载的 Workbook 实例
     */
    public static WorkBook load(InputStream stream) {
        return new WorkBook(stream);
    }

    /**
     * 检查并获取指定名称的工作表。如果不存在，则创建一个新的工作表。
     *
     * <p>此方法用于确保在操作之前工作表存在，如果指定名称的工作表不存在，将自动创建。
     *
     * <p>示例用法：
     * <pre>
     *      workbook.checkout("Sheet2");
     * </pre>
     *
     * @param name 工作表的名称。
     * @throws IllegalArgumentException 如果工作表名称为 {@code null} 或空字符串。
     */
    public void checkout(String name) {
        sheet = Optional.ifNullable(wb.getSheet(name), () -> wb.createSheet(name));
    }

    /**
     * 检查并获取指定名称的工作表。如果不存在，则创建一个新的工作表。
     *
     * <p>此方法用于确保在操作之前工作表存在，如果指定名称的工作表不存在，将自动创建。
     *
     * <p>示例用法：
     * <pre>
     *      workbook.createSheet("Sheet2");
     * </pre>
     *
     * @param name 工作表的名称。
     * @throws IllegalArgumentException 如果工作表名称为 {@code null} 或空字符串。
     */
    public void createSheet(String name) {
        Optional.ifNullable(wb.getSheet(name), () -> wb.createSheet(name));
    }

    /**
     * 向工作表添加一行数据。
     *
     * <p>此方法将接受任意数量的参数，并将它们作为单元格的内容添加到当前工作表中。
     *
     * <p>注意：如果参数为 null，单元格将设置为一个空字符串。
     *
     * <p>示例用法：
     * <pre>
     *      Workbook workbook = new Workbook();
     *      workbook.addRow("数据1", "数据2", "数据3");
     * </pre>
     *
     * @param values 行数据，类型为 Object 变长参数。
     *
     */
    public void addRow(Object... values) {
        addRow(new Row(Lists.map(values, TypeConverter::atos)));
    }

    /**
     * 向工作表添加一行 {@link Row} 对象。
     *
     * <p>此方法将使用给定的 {@link Row} 对象将数据添加到当前工作表。
     *
     * <p>注意：确保 {@code rowUnit} 不是 null。
     *
     * <p>示例用法：
     * <pre>
     *      Row row = new Row();
     *      row.add("数据1");
     *      workbook.addRow(row);
     * </pre>
     *
     * @param rowUnit 行数据的 {@link Row} 对象。
     * @throws NullPointerException 如果 {@code rowUnit} 为 null。
     *
     */
    public void addRow(Row rowUnit) {
        int rowNum = sheet.getLastRowNum();
        org.apache.poi.ss.usermodel.Row row = sheet.createRow(rowNum + 1);
        for (int i = 0; i < rowUnit.size(); i++) {
            row.createCell(i).setCellValue(atos(rowUnit.get(i)));
        }
    }

    /**
     * 获取指定索引的行数据。
     *
     * <p>此方法返回指定索引的行的数据，作为一个 {@link Row} 对象。
     *
     * <p>注意：索引必须在有效范围内，否则会抛出异常。
     *
     * <p>示例用法：
     * <pre>
     *      Row row = workbook.getRow(0);
     * </pre>
     *
     * @param index 行的索引。
     * @return {@link Row} 对象，包含该行的所有单元格数据。
     * @throws IndexOutOfBoundsException 如果索引超出范围。
     *
     */
    public Row getRow(int index) {
        org.apache.poi.ss.usermodel.Row row = sheet.getRow(index);
        Row retval = new Row();

        int lastCellNum = cellCount();
        for (int i = 0; i < lastCellNum; i++) {
            Cell cell = row.getCell(i);
            String value = cellFormatter.formatCellValue(cell);
            retval.add(cell != null && StrStaticImports.strnempty(value) ? value : "NULL");
        }

        return retval;
    }

    /**
     * #brief: 获取当前工作表的所有行
     *
     * <p>返回一个包含当前工作表中所有行的列表。
     * 该方法会遍历工作表并将每一行添加到返回的
     * 列表中。
     *
     * <p>如果存在空行，会自动从返回结果中移除空行
     * 的数据。
     *
     *
     * @return 包含当前工作表所有行的列表
     */
    public List<Row> getRows() {
        List<Row> retval = Lists.newArrayList();
        forEach(retval::add);
        return Streams.filter(retval, e -> {
            for (String cell : e) {
                if (StrStaticImports.strne(cell, "NULL"))
                    return true;
            }
            return false;
        });
    }

    /**
     * #brief: 获取当前工作表的行数
     *
     * <p>返回当前工作表中最后一行的索引，代表
     * 行数。注意：行数从 0 开始，因此返回值加 1
     * 才是实际行数。如果工作表为空，返回 -1。
     *
     * @return 当前工作表的行数
     */
    public int rowCount() {
        return sheet.getLastRowNum();
    }

    /**
     * #brief: 获取当前行的单元格数量
     *
     * <p>返回当前工作表第一行的单元格数量。如果
     * 第一行为空，则返回 0。
     *
     * @return 当前行的单元格数量
     */
    public int cellCount() {
        org.apache.poi.ss.usermodel.Row row = sheet.getRow(0);
        if (row != null)
            return row.getLastCellNum();
        return 0;
    }

    /**
     * 将工作簿写入指定的输出流。
     *
     * <p>使用此方法可以将当前工作簿的数据输出到文件或其他输出流中。
     *
     * <p>注意：在写入流之前，请确保流已经打开并可以写入。
     *
     * <p>示例用法：
     * <pre>
     *      try (OutputStream stream = new FileOutputStream("output.xlsx")) {
     *          workbook.write(stream);
     *      }
     * </pre>
     *
     * @param stream 输出流，用于写入工作簿数据。
     *
     */
    public void write(OutputStream stream) {
        Captor.call(() -> wb.write(stream));
    }

    /**
     * #brief: Workbook 的迭代器
     *
     * <p>该内部类实现了迭代器接口，用于遍历Workbook 中的行对象。通过此迭代器，用户
     * 可以方便地遍历工作表中的每一行。<p>
     *
     * <h2>注意事项</h2>
     * <ul>
     *     <li>确保在迭代过程中工作表未被修改，以避免
     *         意外的行为或抛出异常。</li>
     * </ul>
     *
     * @see Iterator
     * @see Row
     */
    public static class WorkbookInterator implements Iterator<Row> {

        private int index;
        private final int size;
        private final WorkBook wb;

        WorkbookInterator(WorkBook wb) {
            this.wb = wb;
            this.index = 0;
            this.size = wb.rowCount() + 1;
        }

        @Override
        public boolean hasNext() {
            return index != size;
        }

        @Override
        public Row next() {
            return wb.getRow(index++);
        }
    }

    @Override
    public Iterator<Row> iterator() {
        return new WorkbookInterator(this);
    }

    /**
     * #brief: 将工作表内容转换为 CSV 格式文本
     *
     * <p>遍历当前工作表的所有行，并将其内容
     * 转换为 CSV 格式的字符串。每行以换行符
     * 分隔，单元格内容之间用逗号分隔。
     *
     * <p>如果单元格的值为 "NULL"，则该单元格
     * 在输出中将为空字符串。
     *
     * @return 转换后的 CSV 格式文本
     */
    public String toCSVText() {
        StringBuilder builder = new StringBuilder();

        List<Row> rows = getRows();
        for (Row row : rows) {
            for (String cell : row) {
                builder.append(StrStaticImports.strne(cell, "NULL") ? cell : "");
                builder.append(",");
            }
            builder.deleteCharAt(builder.length() - 1);
            builder.append("\n");
        }

        return atos(builder);
    }

    private void initializeData(Object obj, UField uField, String value) {
        /* RowColumn */
        RowColumn annotation = uField.getAnnotation(RowColumn.class);

        /* 基础数据类型 */
        if (uField.isPrimitiveCheck())
            uField.set(obj, TypeConverter.toPrimitiveValue(value, uField.getOriginType()));

        /* 日期类型 */
        else if (uField.typecheck(Date.class))
            uField.set(obj, DateFormatter.parse(value, annotation.pattern()));

        /* 浮点类型 */
        else if (uField.typecheck(BigDecimal.class))
            uField.set(obj, new BigDecimal(value));

        /* 字符串 */
        else if (uField.typecheck(String.class))
            uField.set(obj, value);
    }

    /**
     * 将 Excel 数据转换为 Java 对象列表。
     *
     * <p>该方法根据指定的类类型，将工作簿中的数据解析并映射为 Java 对象列表。通过注解 {@link RowColumn}，
     * 确定 Excel 列标题与 Java 类字段的对应关系，逐行解析并生成对象。<p>
     *
     * <h2>功能特点</h2>
     * <ul>
     *     <li>支持通过 {@link RowColumn} 注解自动映射 Excel 列与 Java 字段。</li>
     *     <li>动态创建指定类型的对象并初始化字段值。</li>
     *     <li>适用于基于注解驱动的数据导入场景。</li>
     * </ul>
     *
     * <h2>使用示例</h2>
     * <pre>
     *     public class User {
     *         \@RowColumn(name = "用户名")
     *         private String username;
     *
     *         \@RowColumn(name = "年龄")
     *         private int age;
     *     }
     *
     *     List<User> users = excelHandler.toJavaObject(User.class);
     * </pre>
     *
     * @param aClass 目标对象的类类型
     * @param <T>    目标对象的泛型类型
     * @return 转换后的对象列表
     */
    @SuppressWarnings("unchecked")
    public <T> List<T> toJavaObject(Class<T> aClass) {
        UClass uClass = new UClass(aClass);

        List<T> retval = Lists.newArrayList();
        Map<String, UField> mapping = Maps.newHashMap();

        // 获取对象中字段列表
        List<UField> uFields = uClass.getDeclaredFields();
        for (UField uField : uFields) {
            if (uField.hasAnnotation(RowColumn.class)) {
                RowColumn rowColumn = uField.getAnnotation(RowColumn.class);
                mapping.put(rowColumn.name(), uField);
            }
        }

        // 读取工作簿中所有行数据
        List<Row> rows = getRows();
        Row titles = rows.remove(0);
        for (Row row : rows) {
            Object obj = uClass.newInstance();
            for (int i = 0; i < row.size(); i++) {
                String title = titles.get(i);
                UField uField = mapping.get(title);
                if (uField != null) {
                    String value = row.get(i);
                    initializeData(obj, uField, value);
                }
            }
            retval.add((T) obj);
        }

        return retval;
    }

    @Override
    public String toString() {
        StringBuilder builder = new StringBuilder();
        getRows().forEach(row -> builder.append(row).append("\n"));
        int len = builder.length();
        return atos(builder.delete(len - 1, len));
    }

    /**
     * #brief: 将数据转移到指定路径的文件
     *
     * <p>将当前数据写入到指定路径的文件中。如果文件不存在，则会创建新文件；
     * 如果文件已存在，则会覆盖其内容。
     *
     * @param pathname 目标文件的路径
     */
    public void transferTo(String pathname) {
        transferTo(new UFile(pathname));
    }

    /**
     * #brief: 将数据转移到指定的可变文件
     *
     * <p>将当前数据写入到指定的 {@link UFile} 对象中。
     * 通过文件对象的字节写入器将数据写入文件。
     *
     * @param file 目标可变文件对象
     */
    public void transferTo(UFile file) {
        /* 直接写文件流，不再先序列化成一整份 byte[]（大表导出少一次整份内存拷贝） */
        file.openByteWriter().call(this::write);
    }

    public byte[] toByteArray() {
        ByteArrayOutputStream outputStream = new ByteArrayOutputStream();
        write(outputStream);
        return outputStream.toByteArray();
    }

}
